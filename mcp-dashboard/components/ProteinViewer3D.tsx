'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { addToDesignLibrary } from '@/lib/design-library'

type RenderMode = 'ribbon' | 'cartoon' | 'sphere' | 'stick' | 'surface'
type SecondaryType = 'helix' | 'sheet' | 'turn' | 'coil'

type Atom = {
  key: string
  element: string
  x: number
  y: number
  z: number
  residue: string
  residueNum: number
  chain: string
  atomName: string
  bFactor: number
}

type ResidueSummary = {
  key: string
  chain: string
  residueNum: number
  residue: string
  atoms: Atom[]
  center: THREE.Vector3
  caAtom?: Atom
  avgBFactor: number
}

type ParseResult = {
  atoms: Atom[]
  residues: ResidueSummary[]
  chains: string[]
  warnings: string[]
  bFactorRange: { min: number; max: number; average: number }
}

type Segment = {
  start: number
  end: number
  type: SecondaryType
}

type ResidueSelection = { chain: string; residueNum: number; residue: string }
type ResidueDetail = ResidueSelection & {
  atomCount: number
  avgBFactor: number
  sequenceResidue?: string
  center: THREE.Vector3
}
type ChainSummary = {
  chain: string
  residueCount: number
  selectedCount: number
  averageBFactor: number
  residueRange: string
}

type SequenceMapEntry = {
  chain: string
  residueNum: number
  residue: string
  sequenceResidue?: string
  avgBFactor: number
  isSelected: boolean
  isHotspot: boolean
}

type BuildResult = {
  group: THREE.Group
  residueCenters: Map<string, THREE.Vector3>
}

type ProposedVariant = {
  sequence?: string
  score?: number
  positions?: number[]
}

interface ProteinViewer3DProps {
  pdbData: string
  onClose: () => void
  title?: string
  sequence?: string
  onUseSequence?: (sequence: string) => void
}

const ELEMENT_COLORS: Record<string, number> = {
  C: 0x909090,
  N: 0x3b82f6,
  O: 0xef4444,
  S: 0xfacc15,
  H: 0xffffff,
  P: 0xf97316,
  default: 0xd946ef,
}

// Van der Waals radii (Å) for spacefill rendering
const VDW_RADII: Record<string, number> = {
  C: 1.70, N: 1.55, O: 1.52, S: 1.80, H: 1.20, P: 1.80, default: 1.50,
}

const SECONDARY_COLORS: Record<SecondaryType, number> = {
  helix: 0xfb7185,
  sheet: 0xfacc15,
  turn: 0x22d3ee,
  coil: 0x94a3b8,
}

// Distinct chain colors for multi-chain structures
const CHAIN_PALETTE: number[] = [
  0x60a5fa, // blue
  0x34d399, // emerald
  0xf472b6, // pink
  0xfbbf24, // amber
  0xa78bfa, // violet
  0xfb923c, // orange
  0x22d3ee, // cyan
  0x86efac, // green
  0xfc8181, // rose
  0xe879f9, // fuchsia
]

// Amino acid physicochemical class → Tailwind color utility classes
const AA_CLASSES: Record<string, string> = {
  // Hydrophobic
  A: 'bg-slate-500/30 text-slate-100', V: 'bg-slate-500/30 text-slate-100',
  L: 'bg-slate-500/30 text-slate-100', I: 'bg-slate-500/30 text-slate-100',
  M: 'bg-slate-500/30 text-slate-100', F: 'bg-slate-600/30 text-slate-100',
  W: 'bg-slate-600/30 text-slate-100', P: 'bg-slate-400/30 text-slate-100',
  // Polar uncharged
  S: 'bg-teal-500/30 text-teal-100', T: 'bg-teal-500/30 text-teal-100',
  C: 'bg-yellow-500/30 text-yellow-100', Y: 'bg-teal-600/30 text-teal-100',
  N: 'bg-teal-400/30 text-teal-100', Q: 'bg-teal-400/30 text-teal-100',
  // Negatively charged
  D: 'bg-rose-500/30 text-rose-100', E: 'bg-rose-500/30 text-rose-100',
  // Positively charged
  K: 'bg-blue-500/30 text-blue-100', R: 'bg-blue-600/30 text-blue-100',
  H: 'bg-blue-400/30 text-blue-100',
  // Special
  G: 'bg-green-500/30 text-green-100',
}

const DEFAULT_NUM_VARIANTS = 5
const SPOTLIGHT_NEIGHBOR_RADIUS = 8
const MIN_SPOTLIGHT_NEIGHBOR_RADIUS = 2
const MAX_SPOTLIGHT_NEIGHBOR_RADIUS = 20
// Fallback half-FOV tangent (tan(30°) ≈ 0.577350269...) used when camera-derived values are unavailable.
const DEFAULT_CAMERA_TAN_HALF_FOV = 0.577
const MIN_CAMERA_TANGENT = 0.001
const MAX_RENDERER_PIXEL_RATIO = 2
const AUTO_ROTATE_SPEED = 1.2

// Eisenberg consensus hydrophobicity scale (3-letter → value in Å²·kcal/mol).
// Positive = hydrophobic, negative = hydrophilic.
const HYDROPHOBICITY_SCALE: Record<string, number> = {
  ILE: 1.38, PHE: 1.19, VAL: 1.08, LEU: 1.06, TRP: 0.81, MET: 0.64,
  ALA: 0.62, GLY: 0.48, CYS: 0.29, TYR: 0.26, PRO: 0.12, THR: -0.05,
  SER: -0.18, HIS: -0.40, GLU: -0.74, ASN: -0.78, GLN: -0.85,
  ASP: -0.90, LYS: -1.50, ARG: -2.53,
}
const HYDRO_MIN = -2.53
const HYDRO_MAX = 1.38

// Full amino-acid names for tooltip enrichment
const AA_FULL_NAMES: Record<string, string> = {
  ALA: 'Alanine', ARG: 'Arginine', ASN: 'Asparagine', ASP: 'Aspartate',
  CYS: 'Cysteine', GLN: 'Glutamine', GLU: 'Glutamate', GLY: 'Glycine',
  HIS: 'Histidine', ILE: 'Isoleucine', LEU: 'Leucine', LYS: 'Lysine',
  MET: 'Methionine', PHE: 'Phenylalanine', PRO: 'Proline', SER: 'Serine',
  THR: 'Threonine', TRP: 'Tryptophan', TYR: 'Tyrosine', VAL: 'Valine',
  UNK: 'Unknown',
}

function getHydrophobicityColor(residueName: string): THREE.Color {
  const val = HYDROPHOBICITY_SCALE[residueName.toUpperCase()] ?? 0
  const norm = (val - HYDRO_MIN) / (HYDRO_MAX - HYDRO_MIN) // 0=hydrophilic, 1=hydrophobic
  // Blue (hydrophilic, 215°) → White (neutral) → Orange (hydrophobic, 30°)
  const hue = norm < 0.5 ? 215 - norm * 2 * (215 - 0) / 1 : 30
  const sat = norm < 0.5 ? 0.75 * (1 - norm * 2) : 0.80 * (norm * 2 - 1)
  const light = 0.52 + 0.25 * (1 - Math.abs(norm * 2 - 1)) // brighter in middle
  return new THREE.Color().setHSL(hue / 360, sat, light)
}

function residueKey(chain: string, residueNum: number) {
  return `${chain || '_'}:${residueNum}`
}

function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

function getAtomPosition(atom: Atom) {
  return new THREE.Vector3(atom.x, atom.y, atom.z)
}

function parsePDB(pdb: string): ParseResult {
  const atoms: Atom[] = []
  const warnings: string[] = []
  const residueMap = new Map<string, { chain: string; residueNum: number; residue: string; atoms: Atom[] }>()
  let malformedCount = 0

  for (const line of pdb.split('\n')) {
    if (!line.startsWith('ATOM') && !line.startsWith('HETATM')) continue

    try {
      const atomName = line.substring(12, 16).trim()
      const element = line.substring(76, 78).trim() || atomName.charAt(0) || 'C'
      const x = Number.parseFloat(line.substring(30, 38))
      const y = Number.parseFloat(line.substring(38, 46))
      const z = Number.parseFloat(line.substring(46, 54))
      const residue = line.substring(17, 20).trim() || 'UNK'
      const residueNum = Number.parseInt(line.substring(22, 26).trim(), 10)
      const chain = line.substring(21, 22).trim() || 'A'
      const bFactor = Number.parseFloat(line.substring(60, 66).trim()) || 0

      if (![x, y, z, residueNum].every(Number.isFinite) || residueNum <= 0) {
        malformedCount += 1
        continue
      }

      const key = `${atoms.length}:${chain}:${residueNum}:${atomName}`
      const atom: Atom = { key, element, x, y, z, residue, residueNum, chain, atomName, bFactor }
      atoms.push(atom)

      const resKey = residueKey(chain, residueNum)
      const bucket = residueMap.get(resKey) || { chain, residueNum, residue, atoms: [] }
      bucket.atoms.push(atom)
      residueMap.set(resKey, bucket)
    } catch {
      malformedCount += 1
    }
  }

  if (malformedCount > 0) {
    warnings.push(`Skipped ${malformedCount} malformed atom record${malformedCount === 1 ? '' : 's'}.`)
  }

  const residues = Array.from(residueMap.values())
    .map((item) => {
      const center = item.atoms.reduce(
        (acc, atom) => acc.add(getAtomPosition(atom)),
        new THREE.Vector3(0, 0, 0)
      )
      center.divideScalar(Math.max(item.atoms.length, 1))
      const caAtom = item.atoms.find((atom) => atom.atomName === 'CA')
      const avgBFactor =
        item.atoms.reduce((sum, atom) => sum + atom.bFactor, 0) / Math.max(item.atoms.length, 1)
      return {
        key: residueKey(item.chain, item.residueNum),
        chain: item.chain,
        residueNum: item.residueNum,
        residue: item.residue,
        atoms: item.atoms,
        center,
        caAtom,
        avgBFactor,
      }
    })
    .sort((a, b) => (a.chain === b.chain ? a.residueNum - b.residueNum : a.chain.localeCompare(b.chain)))

  const chains = Array.from(new Set(residues.map((residue) => residue.chain)))
  const bFactors = atoms.map((atom) => atom.bFactor)
  const min = bFactors.length ? Math.min(...bFactors) : 0
  const max = bFactors.length ? Math.max(...bFactors) : 0
  const average =
    bFactors.length > 0 ? bFactors.reduce((sum, value) => sum + value, 0) / bFactors.length : 0

  return {
    atoms,
    residues,
    chains,
    warnings,
    bFactorRange: { min, max, average },
  }
}

function detectSecondaryStructure(residues: ResidueSummary[]): Segment[] {
  const caResidues = residues.filter((residue) => residue.caAtom)
  if (caResidues.length < 4) {
    return [{ start: 0, end: Math.max(caResidues.length - 1, 0), type: 'coil' }]
  }

  const labels = new Array<SecondaryType>(caResidues.length).fill('coil')

  for (let index = 1; index < caResidues.length - 3; index += 1) {
    const prev = caResidues[index - 1].caAtom!
    const current = caResidues[index].caAtom!
    const next = caResidues[index + 1].caAtom!
    const lookahead = caResidues[index + 2].caAtom!

    const v1 = new THREE.Vector3(current.x - prev.x, current.y - prev.y, current.z - prev.z).normalize()
    const v2 = new THREE.Vector3(next.x - current.x, next.y - current.y, next.z - current.z).normalize()
    const angle = THREE.MathUtils.radToDeg(v1.angleTo(v2))
    // i→i+2 distance: ~5–6 Å for helix, ~6.5–7.5 Å for extended strand
    const iToI2Distance = distance(current, lookahead)
    // i-1→i+1 distance: ~5 Å for helix, ~6.5–7.5 Å for extended strand
    const strandDistance = distance(prev, next)

    // Alpha-helix: consecutive Cα bond vectors turn ~80–100°, i→i+2 distance ~4.8–6.4 Å
    if (iToI2Distance >= 4.8 && iToI2Distance <= 6.4 && angle >= 65 && angle <= 130) {
      labels[index] = 'helix'
      labels[index + 1] = 'helix'
      continue
    }

    // Beta-strand: extended backbone → consecutive bond vectors nearly parallel (small angle),
    // i-1→i+1 distance > 6.2 Å and i→i+2 distance > 6.0 Å
    if (strandDistance >= 6.2 && iToI2Distance >= 6.0 && angle <= 40) {
      labels[index] = 'sheet'
      continue
    }

    // Turn: moderate bend
    if (angle >= 100 && angle < 145) {
      labels[index] = 'turn'
    }
  }

  const segments: Segment[] = []
  let start = 0
  let current = labels[0]

  for (let index = 1; index < labels.length; index += 1) {
    if (labels[index] === current) continue
    segments.push({ start, end: index - 1, type: current })
    start = index
    current = labels[index]
  }
  segments.push({ start, end: labels.length - 1, type: current })

  return segments
}

function getBFactorColor(value: number, range: ParseResult['bFactorRange']) {
  const spread = Math.max(range.max - range.min, 1)
  const normalized = THREE.MathUtils.clamp((value - range.min) / spread, 0, 1)
  return new THREE.Color().setHSL((1 - normalized) * 0.7, 0.95, 0.55)
}

function getStructureColor(type: SecondaryType, heatmap: boolean, value: number, model: ParseResult) {
  return heatmap ? getBFactorColor(value, model.bFactorRange) : new THREE.Color(SECONDARY_COLORS[type])
}

function chainPaletteColor(chain: string, allChains: string[]): THREE.Color {
  const index = allChains.indexOf(chain)
  return new THREE.Color(CHAIN_PALETTE[index >= 0 ? index % CHAIN_PALETTE.length : 0])
}

function addHotspot(
  group: THREE.Group,
  residue: ResidueSummary,
  center: THREE.Vector3,
  selectedKeys: Set<string>
) {
  const geometry = new THREE.SphereGeometry(selectedKeys.has(residue.key) ? 0.6 : 0.45, 12, 12)
  const material = new THREE.MeshBasicMaterial({
    color: selectedKeys.has(residue.key) ? 0xf8fafc : 0x60a5fa,
    transparent: true,
    opacity: selectedKeys.has(residue.key) ? 0.8 : 0.12,
    depthWrite: false,
  })
  const hotspot = new THREE.Mesh(geometry, material)
  hotspot.position.copy(center)
  hotspot.userData = {
    kind: 'residue',
    chain: residue.chain,
    residueNum: residue.residueNum,
    residue: residue.residue,
  }
  group.add(hotspot)
}

function createRibbonRepresentation(
  group: THREE.Group,
  residues: ResidueSummary[],
  model: ParseResult,
  heatmap: boolean,
  selectedKeys: Set<string>,
  chainColor?: THREE.Color
) {
  const caResidues = residues.filter((residue) => residue.caAtom)
  if (caResidues.length < 2) return

  const points = caResidues.map((residue) => getAtomPosition(residue.caAtom!))
  const curve = new THREE.CatmullRomCurve3(points)
  const color = heatmap
    ? getBFactorColor(model.bFactorRange.average, model.bFactorRange)
    : chainColor ?? new THREE.Color(0x93c5fd)
  const tube = new THREE.Mesh(
    new THREE.TubeGeometry(curve, Math.max(points.length * 8, 32), 0.4, 14, false),
    new THREE.MeshPhongMaterial({ color, shininess: 45, transparent: true, opacity: 0.94 })
  )
  group.add(tube)

  for (const residue of caResidues) {
    const center = getAtomPosition(residue.caAtom!)
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(selectedKeys.has(residue.key) ? 0.42 : 0.24, 12, 12),
      new THREE.MeshPhongMaterial({
        color: selectedKeys.has(residue.key)
          ? 0xf8fafc
          : heatmap
            ? getStructureColor('coil', true, residue.avgBFactor, model)
            : chainColor ?? getStructureColor('coil', false, residue.avgBFactor, model),
        emissive: selectedKeys.has(residue.key) ? new THREE.Color(0x2563eb) : new THREE.Color(0x000000),
        emissiveIntensity: selectedKeys.has(residue.key) ? 0.45 : 0,
      })
    )
    marker.position.copy(center)
    marker.userData = {
      kind: 'residue',
      chain: residue.chain,
      residueNum: residue.residueNum,
      residue: residue.residue,
    }
    group.add(marker)
  }
}

function createArrowSegment(start: THREE.Vector3, end: THREE.Vector3, color: THREE.Color) {
  const direction = new THREE.Vector3().subVectors(end, start)
  const length = direction.length()
  const normalized = direction.clone().normalize()
  const arrow = new THREE.ArrowHelper(normalized, start, length, color.getHex(), Math.min(length * 0.3, 2.4), 0.8)
  return arrow
}

function createCartoonRepresentation(
  group: THREE.Group,
  residues: ResidueSummary[],
  model: ParseResult,
  heatmap: boolean,
  selectedKeys: Set<string>,
  chainColor?: THREE.Color
) {
  const caResidues = residues.filter((residue) => residue.caAtom)
  if (caResidues.length < 2) return

  const segments = detectSecondaryStructure(caResidues)
  for (const segment of segments) {
    const segmentResidues = caResidues.slice(segment.start, segment.end + 1)
    if (segmentResidues.length < 2) continue

    const points = segmentResidues.map((residue) => getAtomPosition(residue.caAtom!))
    const averageB =
      segmentResidues.reduce((sum, residue) => sum + residue.avgBFactor, 0) / segmentResidues.length
    const color = heatmap
      ? getStructureColor(segment.type, true, averageB, model)
      : chainColor ?? getStructureColor(segment.type, false, averageB, model)

    if (segment.type === 'sheet') {
      const start = points[0]
      const end = points[points.length - 1]
      const arrow = createArrowSegment(start, end, color)
      group.add(arrow)

      const ribbon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.32, 0.32, start.distanceTo(end), 12, 1, false),
        new THREE.MeshPhongMaterial({ color, transparent: true, opacity: 0.85 })
      )
      ribbon.position.copy(start.clone().add(end).multiplyScalar(0.5))
      ribbon.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3().subVectors(end, start).normalize()
      )
      group.add(ribbon)
    } else {
      const radius = segment.type === 'helix' ? 0.55 : segment.type === 'turn' ? 0.28 : 0.22
      const tubularSegments = Math.max(points.length * 10, 24)
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), tubularSegments, radius, 16, false),
        new THREE.MeshPhongMaterial({ color, shininess: 65, transparent: true, opacity: 0.96 })
      )
      group.add(mesh)
    }
  }

  for (const residue of caResidues) {
    addHotspot(group, residue, getAtomPosition(residue.caAtom!), selectedKeys)
  }
}

function buildBonds(atoms: Atom[]) {
  const cellSize = 2.1
  const grid = new Map<string, number[]>()
  const bonds: Array<[Atom, Atom]> = []

  const keyFor = (x: number, y: number, z: number) =>
    `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}:${Math.floor(z / cellSize)}`

  atoms.forEach((atom, index) => {
    const cx = Math.floor(atom.x / cellSize)
    const cy = Math.floor(atom.y / cellSize)
    const cz = Math.floor(atom.z / cellSize)

    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const bucket = grid.get(`${cx + dx}:${cy + dy}:${cz + dz}`)
          if (!bucket) continue
          for (const otherIndex of bucket) {
            const other = atoms[otherIndex]
            const bondDistance = distance(atom, other)
            if (bondDistance > 0.4 && bondDistance < 1.85) {
              bonds.push([other, atom])
            }
          }
        }
      }
    }

    const key = keyFor(atom.x, atom.y, atom.z)
    const bucket = grid.get(key) || []
    bucket.push(index)
    grid.set(key, bucket)
  })

  return bonds
}

function createAtomicRepresentation(
  group: THREE.Group,
  atoms: Atom[],
  residues: ResidueSummary[],
  selectedKeys: Set<string>,
  stickOnly: boolean
) {
  if (!stickOnly) {
    for (const atom of atoms) {
      const isSelected = selectedKeys.has(residueKey(atom.chain, atom.residueNum))
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(isSelected ? 0.38 : 0.28, 16, 16),
        new THREE.MeshPhongMaterial({
          color: ELEMENT_COLORS[atom.element] || ELEMENT_COLORS.default,
          transparent: selectedKeys.size > 0 && !isSelected,
          opacity: selectedKeys.size > 0 && !isSelected ? 0.18 : 1,
        })
      )
      sphere.position.set(atom.x, atom.y, atom.z)
      sphere.userData = {
        kind: 'atom',
        chain: atom.chain,
        residueNum: atom.residueNum,
        residue: atom.residue,
        atomName: atom.atomName,
      }
      group.add(sphere)
    }
  }

  for (const [left, right] of buildBonds(atoms)) {
    const bondSelected =
      selectedKeys.size === 0 ||
      selectedKeys.has(residueKey(left.chain, left.residueNum)) ||
      selectedKeys.has(residueKey(right.chain, right.residueNum))
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(left.x, left.y, left.z),
      new THREE.Vector3(right.x, right.y, right.z),
    ])
    const material = new THREE.LineBasicMaterial({
      color: 0xcbd5e1,
      transparent: selectedKeys.size > 0 && !bondSelected,
      opacity: selectedKeys.size > 0 && !bondSelected ? 0.18 : 0.9,
    })
    group.add(new THREE.Line(geometry, material))
  }

  for (const residue of residues) {
    addHotspot(group, residue, residue.caAtom ? getAtomPosition(residue.caAtom) : residue.center, selectedKeys)
  }
}

function createSpacefillRepresentation(
  group: THREE.Group,
  atoms: Atom[],
  residues: ResidueSummary[],
  model: ParseResult,
  heatmap: boolean,
  colorByChain: boolean,
  selectedKeys: Set<string>
) {
  for (const atom of atoms) {
    const isSelected = selectedKeys.has(residueKey(atom.chain, atom.residueNum))
    const radius = (VDW_RADII[atom.element] || VDW_RADII.default) * (isSelected ? 1.08 : 1.0)
    const color = heatmap
      ? getBFactorColor(atom.bFactor, model.bFactorRange)
      : colorByChain
        ? chainPaletteColor(atom.chain, model.chains)
        : new THREE.Color(ELEMENT_COLORS[atom.element] || ELEMENT_COLORS.default)
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 16, 12),
      new THREE.MeshPhongMaterial({
        color,
        shininess: 50,
        transparent: selectedKeys.size > 0 && !isSelected,
        opacity: selectedKeys.size > 0 && !isSelected ? 0.15 : 1.0,
      })
    )
    mesh.position.set(atom.x, atom.y, atom.z)
    mesh.userData = {
      kind: 'atom',
      chain: atom.chain,
      residueNum: atom.residueNum,
      residue: atom.residue,
      atomName: atom.atomName,
    }
    group.add(mesh)
  }
  for (const residue of residues) {
    addHotspot(group, residue, residue.caAtom ? getAtomPosition(residue.caAtom) : residue.center, selectedKeys)
  }
}

// Draw 3D measurement lines between selected residue centers (2 = distance, 3 = angle)
function addMeasurementLines(
  group: THREE.Group,
  selectedResidues: ResidueSelection[],
  residueCenters: Map<string, THREE.Vector3>
) {
  const centers = selectedResidues
    .map((s) => residueCenters.get(residueKey(s.chain, s.residueNum)))
    .filter((c): c is THREE.Vector3 => c !== undefined)

  if (centers.length < 2 || centers.length > 3) return

  const pairs: Array<[THREE.Vector3, THREE.Vector3]> =
    centers.length === 2
      ? [[centers[0], centers[1]]]
      : [[centers[0], centers[1]], [centers[1], centers[2]]]

  const lineColor = centers.length === 2 ? 0xfbbf24 : 0x38bdf8

  for (const [a, b] of pairs) {
    const points = [a.clone(), b.clone()]
    const geometry = new THREE.BufferGeometry().setFromPoints(points)
    const material = new THREE.LineDashedMaterial({
      color: lineColor,
      dashSize: 0.7,
      gapSize: 0.35,
      linewidth: 2,
    })
    const line = new THREE.Line(geometry, material)
    line.computeLineDistances()
    group.add(line)
  }

  // Midpoint label sphere for distance (2-residue case)
  if (centers.length === 2) {
    const midpoint = centers[0].clone().add(centers[1]).multiplyScalar(0.5)
    const labelSphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.9 })
    )
    labelSphere.position.copy(midpoint)
    group.add(labelSphere)
  }

  // Center vertex sphere for angle (3-residue case)
  if (centers.length === 3) {
    const pivot = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.9 })
    )
    pivot.position.copy(centers[1])
    group.add(pivot)
  }
}

function buildMolecule(
  model: ParseResult,
  mode: RenderMode,
  heatmap: boolean,
  colorByChain: boolean,
  selectedChain: string,
  selectedResidues: ResidueSelection[],
  showHydrophobicity: boolean,
  colorByAAClass: boolean
): BuildResult {
  const group = new THREE.Group()
  const selectedKeys = new Set(selectedResidues.map((residue) => residueKey(residue.chain, residue.residueNum)))
  const residueCenters = new Map<string, THREE.Vector3>()

  const visibleResidues = model.residues.filter(
    (residue) => selectedChain === 'all' || residue.chain === selectedChain
  )
  const visibleAtoms = model.atoms.filter(
    (atom) => selectedChain === 'all' || atom.chain === selectedChain
  )

  visibleResidues.forEach((residue) => {
    residueCenters.set(residue.key, (residue.caAtom ? getAtomPosition(residue.caAtom) : residue.center).clone())
  })

  const chainGroups = new Map<string, ResidueSummary[]>()
  for (const residue of visibleResidues) {
    const bucket = chainGroups.get(residue.chain) || []
    bucket.push(residue)
    chainGroups.set(residue.chain, bucket)
  }

  if (mode === 'ribbon') {
    chainGroups.forEach((residues, chain) => {
      const chainColor = (colorByChain && !heatmap && !showHydrophobicity) ? chainPaletteColor(chain, model.chains) : undefined
      createRibbonRepresentation(group, residues, model, heatmap, selectedKeys, chainColor)
    })
  } else if (mode === 'cartoon') {
    chainGroups.forEach((residues, chain) => {
      const chainColor = (colorByChain && !heatmap && !showHydrophobicity) ? chainPaletteColor(chain, model.chains) : undefined
      createCartoonRepresentation(group, residues, model, heatmap, selectedKeys, chainColor)
    })
  } else if (mode === 'sphere') {
    createAtomicRepresentation(group, visibleAtoms, visibleResidues, selectedKeys, false)
  } else if (mode === 'surface') {
    createSpacefillRepresentation(group, visibleAtoms, visibleResidues, model, heatmap, colorByChain && !showHydrophobicity, selectedKeys)
  } else {
    createAtomicRepresentation(group, visibleAtoms, visibleResidues, selectedKeys, true)
  }

  // Hydrophobicity overlay: colored Cα spheres on top of the structure
  if (showHydrophobicity && !heatmap) {
    const isSurfaceMode = mode === 'surface'
    for (const residue of visibleResidues) {
      if (!residue.caAtom) continue
      const center = getAtomPosition(residue.caAtom)
      const hydroColor = getHydrophobicityColor(residue.residue)
      const isSelected = selectedKeys.has(residue.key)
      const sphereRadius = isSurfaceMode ? 1.6 : 0.45
      const opacity = isSurfaceMode ? 0.72 : (isSelected ? 0.95 : 0.85)
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(sphereRadius, 14, 10),
        new THREE.MeshPhongMaterial({
          color: hydroColor,
          shininess: 40,
          transparent: true,
          opacity,
          depthWrite: !isSurfaceMode,
        })
      )
      sphere.position.copy(center)
      sphere.userData = {
        kind: 'residue',
        chain: residue.chain,
        residueNum: residue.residueNum,
        residue: residue.residue,
      }
      group.add(sphere)
    }
  }

  // AA-class coloring overlay: discrete physicochemical class colors on Cα spheres
  if (colorByAAClass && !heatmap && !showHydrophobicity) {
    const THREE_TO_ONE_AACLASS: Record<string, string> = { ALA:'A',ARG:'R',ASN:'N',ASP:'D',CYS:'C',GLN:'Q',GLU:'E',GLY:'G',HIS:'H',ILE:'I',LEU:'L',LYS:'K',MET:'M',PHE:'F',PRO:'P',SER:'S',THR:'T',TRP:'W',TYR:'Y',VAL:'V' }
    const AA_CLASS_HEX: Record<string, number> = { hydrophobic: 0x94a3b8, polar: 0x2dd4bf, negative: 0xfb7185, positive: 0x60a5fa, special: 0x86efac }
    const AA_PHYS_MAP: Record<string, string> = { A:'hydrophobic',V:'hydrophobic',L:'hydrophobic',I:'hydrophobic',M:'hydrophobic',F:'hydrophobic',W:'hydrophobic',P:'hydrophobic',S:'polar',T:'polar',C:'polar',Y:'polar',N:'polar',Q:'polar',D:'negative',E:'negative',K:'positive',R:'positive',H:'positive',G:'special' }
    const isSurfaceMode = mode === 'surface'
    for (const residue of visibleResidues) {
      if (!residue.caAtom) continue
      const center = getAtomPosition(residue.caAtom)
      const one = THREE_TO_ONE_AACLASS[residue.residue.toUpperCase()] ?? residue.residue[0] ?? ''
      const cls = AA_PHYS_MAP[one.toUpperCase()] ?? 'hydrophobic'
      const colorHex = AA_CLASS_HEX[cls] ?? 0x9ca3af
      const isSelected = selectedKeys.has(residue.key)
      const sphereRadius = isSurfaceMode ? 1.65 : 0.50
      const opacity = isSurfaceMode ? 0.76 : (isSelected ? 0.96 : 0.88)
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(sphereRadius, 14, 10),
        new THREE.MeshPhongMaterial({
          color: new THREE.Color(colorHex),
          shininess: 45,
          transparent: true,
          opacity,
          depthWrite: !isSurfaceMode,
        })
      )
      sphere.position.copy(center)
      sphere.userData = {
        kind: 'residue',
        chain: residue.chain,
        residueNum: residue.residueNum,
        residue: residue.residue,
      }
      group.add(sphere)
    }
  }

  for (const residue of visibleResidues) {
    if (!selectedKeys.has(residue.key)) continue
    const center = residueCenters.get(residue.key) || residue.center
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.95, 0.08, 10, 24),
      new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.92 })
    )
    ring.position.copy(center)
    ring.rotation.x = Math.PI / 2
    group.add(ring)
  }

  // Add 3D measurement lines for distance (2 selected) or angle (3 selected)
  if (selectedResidues.length === 2 || selectedResidues.length === 3) {
    addMeasurementLines(group, selectedResidues, residueCenters)
  }

  return { group, residueCenters }
}

function formatResidueSelection(selection: ResidueSelection) {
  return `${selection.chain}:${selection.residueNum} ${selection.residue}`
}

function formatResidueRanges(values: number[]) {
  if (values.length === 0) return 'None'

  const unique = Array.from(new Set(values)).sort((a, b) => a - b)
  const ranges: string[] = []
  let start = unique[0]
  let end = unique[0]

  for (let index = 1; index < unique.length; index += 1) {
    const value = unique[index]
    if (value === end + 1) {
      end = value
      continue
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`)
    start = value
    end = value
  }

  ranges.push(start === end ? String(start) : `${start}-${end}`)
  return ranges.join(', ')
}

async function copyTextToClipboard(text: string) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to document.execCommand fallback
  }

  try {
    if (typeof document === 'undefined') return false
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', 'true')
    textarea.style.position = 'absolute'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(textarea)
    return copied
  } catch {
    return false
  }
}

export default function ProteinViewer3D({
  pdbData,
  onClose,
  title,
  sequence,
  onUseSequence,
}: ProteinViewer3DProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const frameRef = useRef<number | null>(null)
  const moleculeRef = useRef<THREE.Group | null>(null)
  const residueCentersRef = useRef<Map<string, THREE.Vector3>>(new Map())
  const analysisRibbonRef = useRef<HTMLDivElement | null>(null)
  const selectionSpotlightRef = useRef<HTMLDivElement | null>(null)
  const workflowSummaryRef = useRef<HTMLElement | null>(null)
  const selectedResiduesRef = useRef<HTMLElement | null>(null)
  const residueInspectorRef = useRef<HTMLElement | null>(null)
  const variantSectionRef = useRef<HTMLElement | null>(null)
  const variantResultsRef = useRef<HTMLElement | null>(null)
  const focusResidueInputRef = useRef<HTMLInputElement | null>(null)
  const hoverClearTimeoutRef = useRef<number | null>(null)

  const [error, setError] = useState<string | null>(null)
  const [renderMode, setRenderMode] = useState<RenderMode>('ribbon')
  const [showHeatmap, setShowHeatmap] = useState(false)
  const [colorByChain, setColorByChain] = useState(true)
  const [showHydrophobicity, setShowHydrophobicity] = useState(false)
  const [colorByAAClass, setColorByAAClass] = useState(false)
  const [selectedResidues, setSelectedResidues] = useState<ResidueSelection[]>([])
  const [positionsText, setPositionsText] = useState('')
  const [numVariants, setNumVariants] = useState(DEFAULT_NUM_VARIANTS)
  const [variantsResult, setVariantsResult] = useState<any>(null)
  const [variantsError, setVariantsError] = useState<string | null>(null)
  const [variantsRunning, setVariantsRunning] = useState(false)
  const [selectedChain, setSelectedChain] = useState('all')
  const [focusResidue, setFocusResidue] = useState('')
  const [analysisMessage, setAnalysisMessage] = useState<string | null>(null)
  const [autoRotate, setAutoRotate] = useState(false)
  const [neighborRadiusAngstrom, setNeighborRadiusAngstrom] = useState(SPOTLIGHT_NEIGHBOR_RADIUS)
  const [hoverInfo, setHoverInfo] = useState<{
    x: number
    y: number
    label: string
    chain: string
    residueNum: number
    residue: string
    atomName?: string
    atomCount: number
    avgBFactor: number
    sequenceResidue?: string
  } | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [labelOverlays, setLabelOverlays] = useState<Array<{ key: string; x: number; y: number; label: string; color: string }>>([])
  const labelOverlaysRef = useRef<Array<{ key: string; x: number; y: number; label: string; color: string }>>([])
  const [showLabels, setShowLabels] = useState(true)
  const selectedResiduesRenderRef = useRef<ResidueSelection[]>([])

  const parsed = useMemo(() => parsePDB(pdbData), [pdbData])

  const residueDetailsMap = useMemo(() => {
    const map = new Map<string, ResidueDetail>()
    parsed.residues.forEach((residue) => {
      map.set(residue.key, {
        chain: residue.chain,
        residueNum: residue.residueNum,
        residue: residue.residue,
        atomCount: residue.atoms.length,
        avgBFactor: residue.avgBFactor,
        sequenceResidue:
          sequence && residue.residueNum >= 1 && residue.residueNum <= sequence.length
            ? sequence[residue.residueNum - 1]
            : undefined,
        center: residue.caAtom ? getAtomPosition(residue.caAtom) : residue.center.clone(),
      })
    })
    return map
  }, [parsed.residues, sequence])

  const selectedResidueDetails = useMemo(
    () =>
      selectedResidues
        .map((selection) => residueDetailsMap.get(residueKey(selection.chain, selection.residueNum)) || null)
        .filter(Boolean) as ResidueDetail[],
    [residueDetailsMap, selectedResidues]
  )

  const selectionSummary = useMemo(() => {
    if (selectedResidueDetails.length === 0) return null

    const positions = selectedResidueDetails.map((item) => item.residueNum)
    let maxDistance = 0
    for (let left = 0; left < selectedResidueDetails.length; left += 1) {
      for (let right = left + 1; right < selectedResidueDetails.length; right += 1) {
        maxDistance = Math.max(
          maxDistance,
          selectedResidueDetails[left].center.distanceTo(selectedResidueDetails[right].center)
        )
      }
    }

    // Cα–Cα–Cα angle when exactly 3 residues are selected
    let tripletsAngleDeg: number | null = null
    if (selectedResidueDetails.length === 3) {
      const [a, b, c] = selectedResidueDetails.map((item) => item.center.clone())
      const vAB = new THREE.Vector3().subVectors(a, b)
      const vCB = new THREE.Vector3().subVectors(c, b)
      if (vAB.lengthSq() > 0 && vCB.lengthSq() > 0) {
        tripletsAngleDeg = THREE.MathUtils.radToDeg(vAB.angleTo(vCB))
      }
    }

    return {
      count: selectedResidueDetails.length,
      primary: selectedResidueDetails[selectedResidueDetails.length - 1],
      ranges: formatResidueRanges(positions),
      averageBFactor:
        selectedResidueDetails.reduce((sum, item) => sum + item.avgBFactor, 0) /
        selectedResidueDetails.length,
      maxDistance,
      tripletsAngleDeg,
    }
  }, [selectedResidueDetails])

  const primarySelectionIndex = useMemo(() => {
    if (!selectionSummary) return -1
    return selectedResidueDetails.findIndex(
      (item) =>
        item.chain === selectionSummary.primary.chain && item.residueNum === selectionSummary.primary.residueNum
    )
  }, [selectedResidueDetails, selectionSummary])

  const selectionAnalytics = useMemo(() => {
    if (selectedResidueDetails.length === 0) return null

    const chains = Array.from(new Set(selectedResidueDetails.map((item) => item.chain)))
    const labels = selectedResidueDetails.map((item) => formatResidueSelection(item))
    let farthestPair:
      | {
          left: string
          right: string
          leftSelection: ResidueSelection
          rightSelection: ResidueSelection
          distance: number
        }
      | null = null

    for (let left = 0; left < selectedResidueDetails.length; left += 1) {
      for (let right = left + 1; right < selectedResidueDetails.length; right += 1) {
        const distance = selectedResidueDetails[left].center.distanceTo(selectedResidueDetails[right].center)
        if (!farthestPair || distance > farthestPair.distance) {
          farthestPair = {
            left: formatResidueSelection(selectedResidueDetails[left]),
            right: formatResidueSelection(selectedResidueDetails[right]),
            leftSelection: {
              chain: selectedResidueDetails[left].chain,
              residueNum: selectedResidueDetails[left].residueNum,
              residue: selectedResidueDetails[left].residue,
            },
            rightSelection: {
              chain: selectedResidueDetails[right].chain,
              residueNum: selectedResidueDetails[right].residueNum,
              residue: selectedResidueDetails[right].residue,
            },
            distance,
          }
        }
      }
    }

    return {
      chains,
      labels,
      averageBFactor:
        selectedResidueDetails.reduce((sum, item) => sum + item.avgBFactor, 0) /
        selectedResidueDetails.length,
      farthestPair,
    }
  }, [selectedResidueDetails])

  // Count neighbors of primary selected residue within neighborRadiusAngstrom
  const primaryNeighborCount = useMemo(() => {
    if (!selectionSummary) return null
    const primaryCenter = selectionSummary.primary.center
    let count = 0
    for (const residue of parsed.residues) {
      const center = residue.caAtom ? getAtomPosition(residue.caAtom) : residue.center
      if (center.distanceTo(primaryCenter) <= neighborRadiusAngstrom) {
        count += 1
      }
    }
    // Subtract 1 to exclude the primary itself
    return Math.max(0, count - 1)
  }, [selectionSummary, parsed.residues, neighborRadiusAngstrom])

  const parsedVariantPositions = useMemo(() => {
    const nums = positionsText
      .split(/[^0-9]+/g)
      .map((token) => token.trim())
      .filter(Boolean)
      .map((token) => Number(token))
      .filter((value) => Number.isFinite(value) && value > 0)
    return Array.from(new Set(nums)).sort((a, b) => a - b)
  }, [positionsText])

  const workflowSummary = useMemo(() => {
    if (!selectionAnalytics) return null

    return {
      residueCount: selectionAnalytics.labels.length,
      chains: selectionAnalytics.chains.join(', '),
      positionsLabel: parsedVariantPositions.length > 0 ? parsedVariantPositions.join(', ') : 'None',
      latestResidue: selectionAnalytics.labels[selectionAnalytics.labels.length - 1],
    }
  }, [parsedVariantPositions, selectionAnalytics])

  const proposedVariants = useMemo<ProposedVariant[]>(
    () => (Array.isArray(variantsResult?.variants) ? variantsResult.variants : []),
    [variantsResult]
  )

  const visibleResidues = useMemo(
    () =>
      parsed.residues.filter((residue) => selectedChain === 'all' || residue.chain === selectedChain),
    [parsed.residues, selectedChain]
  )

  const chainSummaries = useMemo<ChainSummary[]>(
    () =>
      parsed.chains.map((chain) => {
        const chainResidues = parsed.residues.filter((residue) => residue.chain === chain)
        return {
          chain,
          residueCount: chainResidues.length,
          selectedCount: selectedResidues.filter((residue) => residue.chain === chain).length,
          averageBFactor:
            chainResidues.reduce((sum, residue) => sum + residue.avgBFactor, 0) /
            Math.max(chainResidues.length, 1),
          residueRange: formatResidueRanges(chainResidues.map((residue) => residue.residueNum)),
        }
      }),
    [parsed.chains, parsed.residues, selectedResidues]
  )

  // B-factor profile: per-chain residue bFactor array for SVG sparkline chart
  const chainBfactorProfiles = useMemo(() => {
    const result = new Map<string, { residueNum: number; bf: number }[]>()
    for (const chain of parsed.chains) {
      const points = parsed.residues
        .filter((r) => r.chain === chain)
        .map((r) => ({ residueNum: r.residueNum, bf: r.avgBFactor }))
        .sort((a, b) => a.residueNum - b.residueNum)
      result.set(chain, points)
    }
    return result
  }, [parsed.chains, parsed.residues])

  // Contact network keys: residues within neighborRadiusAngstrom of the primary selected residue
  const contactNetworkKeys = useMemo(() => {
    if (!selectionSummary) return new Set<string>()
    const primaryCenter = selectionSummary.primary.center
    const keys = new Set<string>()
    for (const residue of parsed.residues) {
      const center = residue.caAtom ? getAtomPosition(residue.caAtom) : residue.center
      if (center.distanceTo(primaryCenter) <= neighborRadiusAngstrom) {
        keys.add(residue.key)
      }
    }
    // Remove the primary itself
    keys.delete(residueKey(selectionSummary.primary.chain, selectionSummary.primary.residueNum))
    return keys
  }, [selectionSummary, parsed.residues, neighborRadiusAngstrom])

  const hotspotKeys = useMemo(() => {
    return new Set(
      visibleResidues
        .slice()
        .sort((left, right) => right.avgBFactor - left.avgBFactor || left.residueNum - right.residueNum)
        .slice(0, Math.min(5, visibleResidues.length))
        .map((residue) => residue.key)
    )
  }, [visibleResidues])

  const sequenceMapEntries = useMemo<SequenceMapEntry[]>(() => {
    return visibleResidues.slice(0, 180).map((residue) => ({
      chain: residue.chain,
      residueNum: residue.residueNum,
      residue: residue.residue,
      sequenceResidue:
        sequence && residue.residueNum >= 1 && residue.residueNum <= sequence.length
          ? sequence[residue.residueNum - 1]
          : undefined,
      avgBFactor: residue.avgBFactor,
      isSelected: selectedResidues.some(
        (item) => item.chain === residue.chain && item.residueNum === residue.residueNum
      ),
      isHotspot: hotspotKeys.has(residue.key),
    }))
  }, [hotspotKeys, selectedResidues, sequence, visibleResidues])

  const secondaryStructureComposition = useMemo(() => {
    const caResidues = visibleResidues.filter((r) => r.caAtom)
    if (caResidues.length === 0) return null
    const segments = detectSecondaryStructure(caResidues)
    const counts: Record<SecondaryType, number> = { helix: 0, sheet: 0, turn: 0, coil: 0 }
    for (const seg of segments) {
      const len = seg.end - seg.start + 1
      counts[seg.type] += len
    }
    const total = caResidues.length
    return {
      helix: Math.round((counts.helix / total) * 100),
      sheet: Math.round((counts.sheet / total) * 100),
      turn: Math.round((counts.turn / total) * 100),
      coil: Math.round((counts.coil / total) * 100),
    }
  }, [visibleResidues])

  // Per-residue SS type for the sequence strip
  const residueSSTypes = useMemo(() => {
    const caResidues = visibleResidues.filter((r) => r.caAtom)
    if (caResidues.length === 0) return new Map<string, SecondaryType>()
    const segments = detectSecondaryStructure(caResidues)
    const map = new Map<string, SecondaryType>()
    for (const seg of segments) {
      for (let i = seg.start; i <= seg.end; i += 1) {
        const residue = caResidues[i]
        if (residue) map.set(residue.key, seg.type)
      }
    }
    return map
  }, [visibleResidues])

  useEffect(() => {
    setSelectedResidues((prev) => {
      const next = prev.filter((residue) => selectedChain === 'all' || residue.chain === selectedChain)
      if (next.length !== prev.length) {
        const positions = Array.from(new Set(next.map((residue) => residue.residueNum))).sort((a, b) => a - b)
        setPositionsText(positions.join(','))
      }
      return next
    })
  }, [selectedChain])

  // Keep a ref in sync with selectedResidues for the animation loop (avoids window globals)
  useEffect(() => {
    selectedResiduesRenderRef.current = selectedResidues
  }, [selectedResidues])

  useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.autoRotate = autoRotate
    }
  }, [autoRotate])

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      const tagName = target.tagName
      return (
        tagName === 'INPUT' ||
        tagName === 'TEXTAREA' ||
        tagName === 'SELECT' ||
        target.isContentEditable
      )
    }

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return

      const typingTarget = isTypingTarget(event.target)
      if (event.key === '/' && !typingTarget) {
        event.preventDefault()
        focusResidueInputRef.current?.focus()
        focusResidueInputRef.current?.select()
        setAnalysisMessage('Focused residue search. Type a value like A:42 and press Go.')
        return
      }

      if (typingTarget) return

      switch (event.key.toLowerCase()) {
        case 'f':
          setIsFullscreen((prev) => !prev)
          setAnalysisMessage('Toggled fullscreen mode.')
          break
        case 'c':
          setColorByChain((prev) => !prev)
          setAnalysisMessage('Toggled chain-based coloring.')
          break
        case 'l':
          setShowLabels((prev) => !prev)
          setAnalysisMessage('Toggled residue labels.')
          break
        case 'h':
          setShowHeatmap((prev) => !prev)
          setAnalysisMessage('Toggled B-factor heatmap.')
          break
        case 'y':
          setShowHydrophobicity((prev) => !prev)
          setAnalysisMessage('Toggled hydrophobicity coloring.')
          break
        case 'a':
          setColorByAAClass((prev) => !prev)
          setAnalysisMessage('Toggled amino-acid class coloring.')
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [onClose])

  const parsePositions = (text: string) => {
    const nums = text
      .split(/[^0-9]+/g)
      .map((token) => token.trim())
      .filter(Boolean)
      .map((token) => Number(token))
      .filter((value) => Number.isFinite(value) && value > 0)
    return Array.from(new Set(nums)).sort((a, b) => a - b)
  }

  const formatAngstrom = (value: number) => {
    return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '')
  }

  const updateNeighborRadius = (value: number) => {
    if (!Number.isFinite(value)) return
    setNeighborRadiusAngstrom(
      Math.min(
        MAX_SPOTLIGHT_NEIGHBOR_RADIUS,
        Math.max(MIN_SPOTLIGHT_NEIGHBOR_RADIUS, Number(value.toFixed(1)))
      )
    )
  }

  const updateNumVariants = (value: number) => {
    setNumVariants(
      Number.isFinite(value) && value >= 1 ? Math.min(20, Math.floor(value)) : DEFAULT_NUM_VARIANTS
    )
  }

  const syncPositionsFromSelection = (selection: ResidueSelection[]) => {
    const positions = Array.from(new Set(selection.map((residue) => residue.residueNum))).sort((a, b) => a - b)
    setPositionsText(positions.join(','))
  }

  const applySelection = (selection: ResidueSelection[], message?: string) => {
    setSelectedResidues(selection)
    syncPositionsFromSelection(selection)
    if (message) {
      setAnalysisMessage(message)
    }
  }

  const cancelHoverClear = useCallback(() => {
    if (hoverClearTimeoutRef.current) {
      window.clearTimeout(hoverClearTimeoutRef.current)
      hoverClearTimeoutRef.current = null
    }
  }, [])

  const scheduleHoverClear = useCallback((delay = 140) => {
    cancelHoverClear()
    hoverClearTimeoutRef.current = window.setTimeout(() => {
      setHoverInfo(null)
      hoverClearTimeoutRef.current = null
    }, delay)
  }, [cancelHoverClear])

  const toggleResidueSelection = useCallback((selection: ResidueSelection, options?: { silent?: boolean }) => {
    let isSelected = false
    setSelectedResidues((prev) => {
      isSelected = prev.some((item) => item.chain === selection.chain && item.residueNum === selection.residueNum)
      const next = isSelected
        ? prev.filter((item) => !(item.chain === selection.chain && item.residueNum === selection.residueNum))
        : [...prev, selection]
      syncPositionsFromSelection(next)
      return next
    })

    if (!options?.silent) {
      setAnalysisMessage(
        isSelected
          ? `Removed residue ${selection.chain}:${selection.residueNum} from the active selection.`
          : `Added residue ${selection.chain}:${selection.residueNum} to the active selection.`
      )
    }

    return !isSelected
  }, [])

  const selectHotspots = (limit: number, chainOverride?: string) => {
    const effectiveChain = chainOverride || selectedChain
    const residues = parsed.residues
      .filter((residue) => effectiveChain === 'all' || residue.chain === effectiveChain)
      .sort((left, right) => right.avgBFactor - left.avgBFactor || left.residueNum - right.residueNum)
      .slice(0, limit)
      .map((residue) => ({
        chain: residue.chain,
        residueNum: residue.residueNum,
        residue: residue.residue,
      }))

    if (residues.length === 0) {
      setAnalysisMessage('No residues are available for hotspot analysis.')
      return
    }

    if (chainOverride && selectedChain !== chainOverride) {
      setSelectedChain(chainOverride)
    }

    applySelection(
      residues,
      `Selected ${residues.length} high B-factor hotspot${residues.length === 1 ? '' : 's'}${
        chainOverride ? ` in chain ${chainOverride}` : ''
      }.`
    )

    window.setTimeout(() => {
      const scrollTarget =
        typeof window !== 'undefined' && window.innerWidth < 1024
          ? selectionSpotlightRef.current || analysisRibbonRef.current || workflowSummaryRef.current
          : workflowSummaryRef.current || analysisRibbonRef.current
      scrollTarget?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 0)
  }

  const selectChainResidues = (chain: string) => {
    const residues = parsed.residues
      .filter((residue) => residue.chain === chain)
      .map((residue) => ({
        chain: residue.chain,
        residueNum: residue.residueNum,
        residue: residue.residue,
      }))

    if (residues.length === 0) {
      setAnalysisMessage(`No residues are available in chain ${chain}.`)
      return
    }

    if (selectedChain !== chain) {
      setSelectedChain(chain)
    }

    applySelection(
      residues,
      `Selected all ${residues.length} residue${residues.length === 1 ? '' : 's'} in chain ${chain}.`
    )
  }

  const copyChainPositions = async (chain: string) => {
    const positions = Array.from(
      new Set(parsed.residues.filter((residue) => residue.chain === chain).map((residue) => residue.residueNum))
    ).sort((left, right) => left - right)
    if (positions.length === 0) {
      setAnalysisMessage(`No positions are available in chain ${chain}.`)
      return
    }

    const text = positions.join(',')
    const copied = await copyTextToClipboard(text)
    setAnalysisMessage(
      copied
        ? `Copied ${positions.length} position${positions.length === 1 ? '' : 's'} for chain ${chain}.`
        : `Chain ${chain} positions ready to copy: ${text}.`
    )
  }

  const toggleLegendChain = (chain: string) => {
    setSelectedChain((prev) => {
      const next = prev === chain ? 'all' : chain
      setAnalysisMessage(next === 'all' ? 'Showing all chains in the structure.' : `Showing only chain ${chain}.`)
      return next
    })
  }

  const copySelectedPositions = async () => {
    if (!positionsText.trim()) {
      setAnalysisMessage('Select residues before copying variant positions.')
      return
    }

    const copied = await copyTextToClipboard(positionsText)
    setAnalysisMessage(
      copied
        ? `Copied variant positions ${positionsText}.`
        : `Variant positions ready to copy: ${positionsText}.`
    )
  }

  const copySelectedResidues = async () => {
    if (!selectionAnalytics || selectionAnalytics.labels.length === 0) {
      setAnalysisMessage('Select residues before copying residue labels.')
      return
    }

    const text = selectionAnalytics.labels.join(', ')
    const copied = await copyTextToClipboard(text)
    setAnalysisMessage(copied ? `Copied selected residues ${text}.` : `Selected residues ready to copy: ${text}.`)
  }

  const copySelectedFasta = async () => {
    if (!sequence || !sequence.trim()) {
      setAnalysisMessage('Sequence is not available for FASTA export.')
      return
    }

    const positions = new Set(selectedResidues.map((residue) => residue.residueNum))
    const fasta = Array.from(positions)
      .sort((left, right) => left - right)
      .filter((position) => position >= 1 && position <= sequence.length)
      .map((position) => sequence[position - 1])
      .join('')

    if (!fasta) {
      setAnalysisMessage('Select residues with valid sequence positions before exporting FASTA.')
      return
    }

    const header = `>Selection_${fasta.length}aa`
    const copied = await copyTextToClipboard(`${header}\n${fasta}`)
    setAnalysisMessage(copied ? `Copied FASTA for ${fasta.length} selected residue${fasta.length === 1 ? '' : 's'}.` : `FASTA ready to copy for ${fasta.length} selected residue${fasta.length === 1 ? '' : 's'}.`)
  }

  const selectFarthestPair = () => {
    if (!selectionAnalytics?.farthestPair) {
      setAnalysisMessage('Select at least two residues before using the farthest pair.')
      return
    }

    const pair = selectionAnalytics.farthestPair
    applySelection(
      [pair.leftSelection, pair.rightSelection],
      `Selected farthest pair ${pair.left} ↔ ${pair.right} (${pair.distance.toFixed(1)} Å).`
    )
  }

  const copyFarthestPair = async () => {
    if (!selectionAnalytics?.farthestPair) {
      setAnalysisMessage('Select at least two residues before copying a measured pair.')
      return
    }

    const pair = selectionAnalytics.farthestPair
    const text = `${pair.left} ↔ ${pair.right} (${pair.distance.toFixed(1)} Å)`
    const copied = await copyTextToClipboard(text)
    setAnalysisMessage(copied ? `Copied widest pair ${text}.` : `Widest pair ready to copy: ${text}.`)
  }

  const focusSelectionFromSpotlight = (selection: ResidueSelection) => {
    setSelectedResidues((prev) => {
      const match = prev.find(
        (item) => item.chain === selection.chain && item.residueNum === selection.residueNum
      )
      if (!match) return prev
      return [...prev.filter((item) => !(item.chain === match.chain && item.residueNum === match.residueNum)), match]
    })
    focusSelectionEntry(selection)
  }

  const cycleSpotlightSelection = (offset: number) => {
    if (selectedResidueDetails.length === 0) {
      setAnalysisMessage('Select residues before cycling through the spotlight.')
      return
    }

    const baseIndex = primarySelectionIndex >= 0 ? primarySelectionIndex : selectedResidueDetails.length - 1
    const nextIndex = (baseIndex + offset + selectedResidueDetails.length) % selectedResidueDetails.length
    const target = selectedResidueDetails[nextIndex]
    focusSelectionFromSpotlight(target)
  }

  const selectNearbyResiduesFromSpotlight = () => {
    if (!selectionSummary) {
      setAnalysisMessage('Select a residue before finding nearby contacts.')
      return
    }

    const effectiveNeighborRadius = Number.isFinite(neighborRadiusAngstrom)
      ? neighborRadiusAngstrom
      : SPOTLIGHT_NEIGHBOR_RADIUS
    const neighborRadiusLabel = formatAngstrom(effectiveNeighborRadius)
    const primaryCenter = selectionSummary.primary.center
    const nearby = parsed.residues
      .map((residue) => {
        const center = residue.caAtom ? getAtomPosition(residue.caAtom) : residue.center
        return {
          chain: residue.chain,
          residueNum: residue.residueNum,
          residue: residue.residue,
          distance: center.distanceTo(primaryCenter),
        }
      })
      .filter((item) => item.distance <= effectiveNeighborRadius)
      .sort((left, right) => left.distance - right.distance || left.residueNum - right.residueNum)
      .slice(0, 24)
      .map(({ chain, residueNum, residue }) => ({ chain, residueNum, residue }))

    if (nearby.length === 0) {
      setAnalysisMessage(
        `No residues found within ${neighborRadiusLabel} Å of ${selectionSummary.primary.chain}:${selectionSummary.primary.residueNum}.`
      )
      return
    }

    applySelection(
      nearby,
      `Selected ${nearby.length} residue${nearby.length === 1 ? '' : 's'} within ${neighborRadiusLabel} Å of ${
        selectionSummary.primary.chain
      }:${selectionSummary.primary.residueNum}.`
    )
  }

  const scrollToVariantProposal = () => {
    if (!variantSectionRef.current) {
      setAnalysisMessage('Variant proposal controls are not available for this structure.')
      return
    }

    variantSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setAnalysisMessage('Jumped to the variant proposal workspace.')
  }

  const scrollToDetailedAnalysis = () => {
    const target = workflowSummaryRef.current || selectedResiduesRef.current || variantSectionRef.current
    if (!target) {
      setAnalysisMessage('Detailed analysis panels are not available for this structure.')
      return
    }

    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setAnalysisMessage('Jumped to the detailed analysis workspace.')
  }

  const scrollToResidueInspector = () => {
    const target = residueInspectorRef.current || selectedResiduesRef.current
    if (!target) {
      setAnalysisMessage('Residue inspection panels are not available for this structure.')
      return
    }

    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setAnalysisMessage('Jumped to the residue inspector workspace.')
  }

  const scrollToVariantResults = () => {
    if (!variantResultsRef.current) {
      setAnalysisMessage('Proposed variants are not available yet.')
      return
    }

    variantResultsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setAnalysisMessage('Jumped to the proposed variants list.')
  }

  const iterateWithVariant = (variant: ProposedVariant) => {
    if (typeof variant.sequence !== 'string' || !onUseSequence) return
    onUseSequence(variant.sequence)
    onClose()
  }

  const saveVariantToLibrary = (variant: ProposedVariant) => {
    if (typeof variant.sequence !== 'string') return
    addToDesignLibrary({
      sequence: variant.sequence,
      score: typeof variant.score === 'number' ? variant.score : undefined,
      positions: Array.isArray(variant.positions) ? variant.positions : undefined,
      source: title || '3D Viewer Variant',
      pdbData,
    })
    setAnalysisMessage('Saved proposed variant to the Design Library.')
  }

  const frameCurrentMolecule = (box: THREE.Box3) => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (!camera || !controls || box.isEmpty()) return

    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z, 1)
    const fov = THREE.MathUtils.degToRad(camera.fov)
    const tangent = Math.tan(fov / 2)
    const safeTangent =
      Number.isFinite(tangent) && tangent > MIN_CAMERA_TANGENT ? tangent : DEFAULT_CAMERA_TAN_HALF_FOV
    const distance = (maxDim / 2) / safeTangent

    camera.position.set(center.x + distance * 0.35, center.y + distance * 0.25, center.z + distance * 1.35)
    camera.near = Math.max(0.1, distance / 100)
    camera.far = Math.max(1000, distance * 20)
    camera.updateProjectionMatrix()
    controls.target.copy(center)
    controls.update()
  }

  const resetView = () => {
    const molecule = moleculeRef.current
    if (!molecule) return
    frameCurrentMolecule(new THREE.Box3().setFromObject(molecule))
    setAnalysisMessage(null)
  }

  const focusSelection = () => {
    if (selectedResidueDetails.length === 0) {
      setAnalysisMessage('Select at least one residue to center the camera.')
      return
    }

    const box = new THREE.Box3().setFromPoints(selectedResidueDetails.map((item) => item.center.clone()))
    box.expandByScalar(Math.max(2, selectedResidueDetails.length * 0.35))
    frameCurrentMolecule(box)
    setAnalysisMessage(
      `Centered ${selectedResidueDetails.length} selected residue${
        selectedResidueDetails.length === 1 ? '' : 's'
      }.`
    )
  }

  const focusSelectionEntry = (selection: ResidueSelection) => {
    const controls = controlsRef.current
    const camera = cameraRef.current
    const center = residueCentersRef.current.get(residueKey(selection.chain, selection.residueNum))
    if (!controls || !camera || !center) {
      setAnalysisMessage(`Residue ${selection.chain}:${selection.residueNum} is not present in the visible structure.`)
      return false
    }

    controls.target.copy(center)
    camera.position.copy(center.clone().add(new THREE.Vector3(4, 4, 10)))
    controls.update()
    setAnalysisMessage(`Focused on residue ${selection.chain}:${selection.residueNum}.`)
    return true
  }

  const selectSingleResidue = (selection: ResidueSelection) => {
    applySelection([selection], `Selected residue ${selection.chain}:${selection.residueNum}.`)
    focusSelectionEntry(selection)
  }

  const handleResidueTokenClick = (
    event: React.MouseEvent<HTMLButtonElement>,
    selection: ResidueSelection
  ) => {
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      const added = toggleResidueSelection(selection)
      if (added) {
        focusSelectionEntry(selection)
      }
      return
    }
    selectSingleResidue(selection)
  }

  const focusHoveredResidue = () => {
    if (!hoverInfo) {
      setAnalysisMessage('Hover over a residue to focus it.')
      return
    }

    const selection = {
      chain: hoverInfo.chain,
      residueNum: hoverInfo.residueNum,
      residue: hoverInfo.residue,
    }

    selectSingleResidue(selection)
  }

  const toggleHoveredResidue = () => {
    if (!hoverInfo) {
      setAnalysisMessage('Hover over a residue to add it to the selection.')
      return
    }

    toggleResidueSelection({
      chain: hoverInfo.chain,
      residueNum: hoverInfo.residueNum,
      residue: hoverInfo.residue,
    })
  }

  const downloadSnapshot = async () => {
    const renderer = rendererRef.current
    if (!renderer) {
      setAnalysisMessage('3D canvas is not ready yet.')
      return
    }

    const snapshotBaseName = (title || 'protein-viewer')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'protein-viewer'
    const filename = `${snapshotBaseName}.png`

    try {
      const dataUrl = renderer.domElement.toDataURL('image/png')
      const link = document.createElement('a')
      link.href = dataUrl
      link.download = filename
      link.click()
      setAnalysisMessage(`Saved viewer snapshot as ${filename}.`)
    } catch {
      setAnalysisMessage('Unable to export a PNG snapshot from this browser context.')
    }
  }

  const downloadPDB = () => {
    if (!pdbData) {
      setAnalysisMessage('No PDB data available to download.')
      return
    }
    const baseName = (title || 'structure')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'structure'
    const filename = `${baseName}.pdb`
    try {
      const blob = new Blob([pdbData], { type: 'chemical/x-pdb' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.click()
      URL.revokeObjectURL(url)
      setAnalysisMessage(`Saved PDB structure as ${filename}.`)
    } catch {
      setAnalysisMessage('Unable to export the PDB structure in this browser context.')
    }
  }

  const selectAllResidues = () => {
    const residues = visibleResidues.map((residue) => ({
      chain: residue.chain,
      residueNum: residue.residueNum,
      residue: residue.residue,
    }))
    if (residues.length === 0) {
      setAnalysisMessage('No residues visible to select.')
      return
    }
    applySelection(residues, `Selected all ${residues.length} visible residue${residues.length === 1 ? '' : 's'}.`)
  }

  const invertSelection = () => {
    const selectedSet = new Set(selectedResidues.map((r) => residueKey(r.chain, r.residueNum)))
    const inverted = visibleResidues
      .filter((residue) => !selectedSet.has(residue.key))
      .map((residue) => ({ chain: residue.chain, residueNum: residue.residueNum, residue: residue.residue }))
    applySelection(
      inverted,
      inverted.length === 0
        ? 'Nothing left after inverting — cleared selection.'
        : `Inverted selection: ${inverted.length} residue${inverted.length === 1 ? '' : 's'} selected.`
    )
  }

  const selectContactNetwork = () => {
    if (!selectionSummary) {
      setAnalysisMessage('Select a residue first to build a contact network.')
      return
    }
    if (contactNetworkKeys.size === 0) {
      setAnalysisMessage('No neighboring residues found within the current radius.')
      return
    }

    const primarySelection: ResidueSelection = {
      chain: selectionSummary.primary.chain,
      residueNum: selectionSummary.primary.residueNum,
      residue: selectionSummary.primary.residue,
    }
    const neighbors = parsed.residues
      .filter((residue) => contactNetworkKeys.has(residue.key))
      .map((residue) => ({
        chain: residue.chain,
        residueNum: residue.residueNum,
        residue: residue.residue,
      }))
    const nextSelection = [primarySelection, ...neighbors]
    applySelection(
      nextSelection,
      `Selected contact network around ${primarySelection.chain}:${primarySelection.residueNum} (${neighbors.length} neighbor${
        neighbors.length === 1 ? '' : 's'
      }).`
    )
    focusSelectionEntry(primarySelection)
  }

  const interfaceContactRadius = 8 // Å — default inter-chain contact cutoff

  const selectBindingInterface = () => {
    if (parsed.chains.length < 2) {
      setAnalysisMessage('Need at least 2 chains to detect a binding interface.')
      return
    }

    // Build a map from chain → array of Cα positions
    const chainCenters = new Map<string, Array<{ key: string; center: THREE.Vector3; chain: string; residueNum: number; residue: string }>>()
    for (const residue of parsed.residues) {
      const center = residue.caAtom ? getAtomPosition(residue.caAtom) : residue.center
      const bucket = chainCenters.get(residue.chain) || []
      bucket.push({ key: residue.key, center, chain: residue.chain, residueNum: residue.residueNum, residue: residue.residue })
      chainCenters.set(residue.chain, bucket)
    }

    const interfaceSet = new Set<string>()
    const allChains = Array.from(chainCenters.keys())

    for (let i = 0; i < allChains.length; i += 1) {
      const chainA = allChains[i]
      const residuesA = chainCenters.get(chainA) || []
      for (let j = i + 1; j < allChains.length; j += 1) {
        const chainB = allChains[j]
        const residuesB = chainCenters.get(chainB) || []
        for (const rA of residuesA) {
          for (const rB of residuesB) {
            if (rA.center.distanceTo(rB.center) <= interfaceContactRadius) {
              interfaceSet.add(rA.key)
              interfaceSet.add(rB.key)
            }
          }
        }
      }
    }

    if (interfaceSet.size === 0) {
      setAnalysisMessage(`No inter-chain contacts found within ${interfaceContactRadius} Å.`)
      return
    }

    const interfaceResidues: ResidueSelection[] = parsed.residues
      .filter((r) => interfaceSet.has(r.key))
      .map((r) => ({ chain: r.chain, residueNum: r.residueNum, residue: r.residue }))

    applySelection(
      interfaceResidues,
      `Selected ${interfaceResidues.length} binding interface residue${interfaceResidues.length === 1 ? '' : 's'} across ${parsed.chains.length} chains (≤${interfaceContactRadius} Å).`
    )
  }

  const focusOnResidue = () => {
    const query = focusResidue.trim()
    if (!query) {
      setAnalysisMessage('Enter a residue number, range (e.g. A:1-20), or chain:number to focus.')
      return
    }

    // Range selection: detect "A:1-20" or "1-20" format
    const rangeMatch = query.match(/^([A-Za-z]?):?(\d+)-(\d+)$/)
    if (rangeMatch) {
      const rangeChain = rangeMatch[1] ? rangeMatch[1].toUpperCase() : (selectedChain !== 'all' ? selectedChain : '')
      const startNum = Number.parseInt(rangeMatch[2], 10)
      const endNum = Number.parseInt(rangeMatch[3], 10)
      if (startNum <= endNum) {
        const rangeResidues = parsed.residues
          .filter((r) => (!rangeChain || r.chain === rangeChain) && r.residueNum >= startNum && r.residueNum <= endNum)
          .map((r) => ({ chain: r.chain, residueNum: r.residueNum, residue: r.residue }))
        if (rangeResidues.length > 0) {
          applySelection(
            rangeResidues,
            `Selected ${rangeResidues.length} residue${rangeResidues.length === 1 ? '' : 's'} in range ${rangeChain ? rangeChain + ':' : ''}${startNum}–${endNum}.`
          )
          setFocusResidue('')
          return
        }
        setAnalysisMessage(`No residues found in range ${query}.`)
        return
      }
      setAnalysisMessage(`Use an ascending residue range like ${rangeChain ? `${rangeChain}:` : ''}${endNum}-${startNum}.`)
      return
    }

    let chain = selectedChain !== 'all' ? selectedChain : ''
    let residueNum: number | null = null

    if (query.includes(':')) {
      const [queryChain, residueToken] = query.split(':')
      chain = (queryChain.trim().charAt(0).toUpperCase() || chain).toUpperCase()
      residueNum = Number.parseInt(residueToken.trim(), 10)
    } else {
      residueNum = Number.parseInt(query, 10)
    }

    if (!chain && selectedChain === 'all') {
      const match = visibleResidues.find((residue) => residue.residueNum === residueNum)
      chain = match?.chain || ''
    }

    if (!chain || residueNum === null || !Number.isFinite(residueNum)) {
      setAnalysisMessage('Use formats like 42 or A:42.')
      return
    }

    const resolvedResidueNum = Math.floor(residueNum)
    const key = residueKey(chain, resolvedResidueNum)
    const center = residueCentersRef.current.get(key)
    if (!center) {
      setAnalysisMessage(`Residue ${chain}:${resolvedResidueNum} is not present in the visible structure.`)
      return
    }

    const residue = visibleResidues.find((item) => item.chain === chain && item.residueNum === resolvedResidueNum)
    const selection = { chain, residueNum: resolvedResidueNum, residue: residue?.residue || 'UNK' }

    setSelectedResidues((prev) => {
      if (prev.some((item) => item.chain === selection.chain && item.residueNum === selection.residueNum)) {
        return prev
      }
      const next = [...prev, selection]
      syncPositionsFromSelection(next)
      return next
    })

    focusSelectionEntry(selection)
  }

  const callProposeVariants = async () => {
    setVariantsError(null)
    setVariantsResult(null)

    if (!sequence || !sequence.trim()) {
      setVariantsError('Sequence is not available for this structure')
      return
    }

    const positions = parsePositions(positionsText).filter((position) => position >= 1 && position <= sequence.length)
    if (positions.length === 0) {
      setVariantsError('Select residues in the viewer or enter valid 1-based positions.')
      return
    }

    setVariantsRunning(true)
    try {
      const response = await fetch('/api/mcp/tools/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'propose_sequence_variants',
          arguments: {
            sequence,
            positions,
            num_variants: numVariants,
          },
        }),
      })

      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || `HTTP ${response.status}`)
      }

      const text = payload?.content?.find((item: any) => item?.type === 'text')?.text
      if (typeof text === 'string' && text.trim()) {
        try {
          setVariantsResult(JSON.parse(text))
        } catch {
          setVariantsResult({ variants: [], raw: text })
        }
      }
    } catch (err: any) {
      setVariantsError(err?.message || 'Variant proposal failed')
    } finally {
      setVariantsRunning(false)
    }
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }

    if (rendererRef.current) {
      rendererRef.current.dispose()
      rendererRef.current = null
    }
    if (controlsRef.current) {
      controlsRef.current.dispose()
      controlsRef.current = null
    }
    if (container.firstChild) {
      container.innerHTML = ''
    }

    setError(null)

    if (parsed.atoms.length === 0) {
      setError('No valid atoms found in the provided PDB data.')
      return
    }

    try {
      const scene = new THREE.Scene()
      scene.background = new THREE.Color(0x020617)
      scene.fog = new THREE.Fog(0x020617, 85, 220)
      sceneRef.current = scene

      const width = container.clientWidth || 800
      const height = container.clientHeight || 600
      const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 2000)
      cameraRef.current = camera

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_RENDERER_PIXEL_RATIO))
      renderer.setSize(width, height)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      container.appendChild(renderer.domElement)
      rendererRef.current = renderer

      const controls = new OrbitControls(camera, renderer.domElement)
      controls.enableDamping = true
      controls.dampingFactor = 0.06
      controls.autoRotateSpeed = AUTO_ROTATE_SPEED
       controls.minDistance = 6
       controls.maxDistance = 240
       controlsRef.current = controls

      scene.add(new THREE.AmbientLight(0xffffff, 1.1))

      const keyLight = new THREE.DirectionalLight(0xffffff, 1.2)
      keyLight.position.set(18, 24, 30)
      scene.add(keyLight)

      const rimLight = new THREE.DirectionalLight(0x60a5fa, 0.6)
      rimLight.position.set(-20, -12, -18)
      scene.add(rimLight)

      const grid = new THREE.GridHelper(160, 24, 0x1e293b, 0x0f172a)
      grid.position.y = -25
      scene.add(grid)

      const { group, residueCenters } = buildMolecule(
        parsed,
        renderMode,
        showHeatmap,
        colorByChain,
        selectedChain,
        selectedResidues,
        showHydrophobicity,
        colorByAAClass
      )
      residueCentersRef.current = residueCenters
      moleculeRef.current = group
      scene.add(group)
      frameCurrentMolecule(new THREE.Box3().setFromObject(group))

      const raycaster = new THREE.Raycaster()
      const pointer = new THREE.Vector2()
      const handleClick = (event: MouseEvent) => {
        if (!cameraRef.current || !sceneRef.current || !rendererRef.current) return
        const rect = renderer.domElement.getBoundingClientRect()
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
        pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1)
        raycaster.setFromCamera(pointer, cameraRef.current)

        const hit = raycaster
          .intersectObjects(group.children, true)
          .find((intersection) => ['residue', 'atom'].includes(String(intersection.object.userData?.kind)))
        const data = hit?.object.userData
        if (!data?.residueNum) return

        const selection = {
          chain: String(data.chain || 'A'),
          residueNum: Number(data.residueNum),
          residue: String(data.residue || 'UNK'),
        }

        if (event.shiftKey || event.ctrlKey || event.metaKey) {
          const added = toggleResidueSelection(selection, { silent: true })
          if (added) {
            focusSelectionEntry(selection)
          }
          return
        }

        setSelectedResidues([selection])
        syncPositionsFromSelection([selection])
        setAnalysisMessage(`Selected residue ${selection.chain}:${selection.residueNum}.`)
        focusSelectionEntry(selection)
      }
      renderer.domElement.addEventListener('click', handleClick)

      const handleMouseMove = (event: MouseEvent) => {
        if (!cameraRef.current || !sceneRef.current || !rendererRef.current) return
        cancelHoverClear()
        const rect = renderer.domElement.getBoundingClientRect()
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
        pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1)
        raycaster.setFromCamera(pointer, cameraRef.current)

        const hit = raycaster
          .intersectObjects(group.children, true)
          .find((intersection) => ['residue', 'atom'].includes(String(intersection.object.userData?.kind)))
        const data = hit?.object.userData
        if (data?.residueNum) {
          const atomName = typeof data.atomName === 'string' ? ` (${data.atomName})` : ''
          const detail =
            residueDetailsMap.get(residueKey(String(data.chain || 'A'), Number(data.residueNum))) || null
          setHoverInfo({
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
            label: `${data.chain}:${data.residueNum} ${data.residue}${atomName}`,
            chain: String(data.chain || 'A'),
            residueNum: Number(data.residueNum),
            residue: String(data.residue || 'UNK'),
            atomName: typeof data.atomName === 'string' ? data.atomName : undefined,
            atomCount: detail?.atomCount || 0,
            avgBFactor: detail?.avgBFactor || 0,
            sequenceResidue: detail?.sequenceResidue,
          })
        } else {
          setHoverInfo(null)
        }
      }
      renderer.domElement.addEventListener('mousemove', handleMouseMove)
      renderer.domElement.addEventListener('mouseleave', () => scheduleHoverClear())

      const handleResize = () => {
        const currentContainer = containerRef.current
        if (!currentContainer || !cameraRef.current || !rendererRef.current) return
        cameraRef.current.aspect = currentContainer.clientWidth / currentContainer.clientHeight
        cameraRef.current.updateProjectionMatrix()
        rendererRef.current.setSize(currentContainer.clientWidth, currentContainer.clientHeight)
      }
      window.addEventListener('resize', handleResize)

      const animate = () => {
        frameRef.current = requestAnimationFrame(animate)
        controls.update()
        renderer.render(scene, camera)

        // Update residue label overlays for selected residues
        const rect = renderer.domElement.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          const currentSelected = selectedResiduesRenderRef.current
          if (currentSelected.length > 0) {
            const overlays: typeof labelOverlaysRef.current = []
            for (const r of currentSelected) {
              const key = `${r.chain || '_'}:${r.residueNum}`
              const worldPos = residueCenters.get(key)
              if (!worldPos) continue
              const proj = worldPos.clone().project(camera)
              const x = ((proj.x + 1) / 2) * rect.width
              const y = (-(proj.y - 1) / 2) * rect.height
              if (proj.z < 1) {
                const chain = r.chain || ''
                overlays.push({
                  key,
                  x,
                  y,
                  label: chain ? `${chain}:${r.residueNum}` : String(r.residueNum),
                  color: chain ? `#${chainPaletteColor(chain, parsed.chains).getHexString()}` : '#60a5fa',
                })
              }
            }
            // Only trigger setState when content changes (compare by length + first/last key)
            const prev = labelOverlaysRef.current
            const changed =
              overlays.length !== prev.length ||
              (overlays.length > 0 &&
                (overlays[0].key !== prev[0].key ||
                  Math.abs(overlays[0].x - prev[0].x) > 1 ||
                  Math.abs(overlays[0].y - prev[0].y) > 1))
            if (changed) {
              labelOverlaysRef.current = overlays
              setLabelOverlays(overlays)
            }
          } else if (labelOverlaysRef.current.length > 0) {
            labelOverlaysRef.current = []
            setLabelOverlays([])
          }
        }
      }
      animate()

      return () => {
        window.removeEventListener('resize', handleResize)
        cancelHoverClear()
        renderer.domElement.removeEventListener('click', handleClick)
        renderer.domElement.removeEventListener('mousemove', handleMouseMove)
        if (frameRef.current) {
          cancelAnimationFrame(frameRef.current)
          frameRef.current = null
        }
        controls.dispose()
        renderer.dispose()
        if (container.contains(renderer.domElement)) {
          container.removeChild(renderer.domElement)
        }
      }
    } catch (err) {
      setError(`Failed to render 3D structure: ${String(err)}`)
    }
  }, [
    onClose,
    parsed,
    renderMode,
    colorByChain,
    colorByAAClass,
    selectedChain,
    selectedResidues,
    showHeatmap,
    showHydrophobicity,
    residueDetailsMap,
    toggleResidueSelection,
    cancelHoverClear,
    scheduleHoverClear,
  ])

  const clearSelection = () => {
    applySelection([], 'Cleared the current residue selection.')
  }

  const isHoveredResidueSelected = hoverInfo
    ? selectedResidues.some(
        (item) => item.chain === hoverInfo.chain && item.residueNum === hoverInfo.residueNum
      )
    : false

  const residueStats = {
    atoms: parsed.atoms.length,
    residues: parsed.residues.length,
    visibleResidues: visibleResidues.length,
    chains: parsed.chains.length,
  }

  const viewerContent = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm">
      <div
        data-testid="viewer-modal"
        className="flex h-[92vh] w-full max-w-7xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-slate-900 shadow-2xl shadow-slate-950/40"
      >
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div>
            <div className="flex items-center gap-3">
              <h3 className="text-2xl font-semibold text-white">🔬 3D Protein Structure Viewer</h3>
              <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs font-semibold text-cyan-100">
                Interactive analysis
              </span>
            </div>
            {title && <p className="mt-1 text-sm text-slate-400">{title}</p>}
            {parsed.warnings.length > 0 && (
              <p className="mt-2 text-sm text-amber-300">{parsed.warnings[0]}</p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close 3D Viewer"
            data-testid="close-3d-viewer"
            className="rounded-xl border border-white/10 bg-white/5 p-2 text-slate-300 transition hover:bg-white/10 hover:text-white"
          >
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className={`flex flex-1 flex-col overflow-y-auto lg:grid lg:overflow-hidden ${isFullscreen ? 'lg:grid-cols-1' : 'lg:grid-cols-[minmax(0,1fr)_360px]'}`}>
          <div className="min-w-0 border-b border-white/10 lg:flex lg:min-h-0 lg:flex-col lg:border-b-0 lg:border-r">
            <div
              data-testid="viewer-controls-toolbar"
              className="flex items-center gap-1.5 overflow-x-auto border-b border-white/10 px-4 py-3 pb-4"
            >
              {([
                ['ribbon', 'Ribbon'],
                ['cartoon', 'Cartoon'],
                ['sphere', 'Ball & Stick'],
                ['stick', 'Stick'],
                ['surface', 'Spacefill'],
              ] as Array<[RenderMode, string]>).map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => setRenderMode(mode)}
                    className={`shrink-0 rounded-full px-2.5 py-2 text-xs font-medium transition sm:text-sm ${
                      renderMode === mode
                        ? 'bg-cyan-400 text-slate-950'
                        : 'bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  {label}
                </button>
              ))}

              <button
                data-testid="viewer-heatmap"
                onClick={() => setShowHeatmap((prev) => !prev)}
                className={`shrink-0 rounded-full px-2.5 py-2 text-xs font-medium transition sm:text-sm ${
                  showHeatmap
                    ? 'bg-amber-400 text-slate-950'
                    : 'bg-white/5 text-slate-300 hover:bg-white/10'
                }`}
                title="B-factor heatmap"
              >
                Heatmap
              </button>

              <button
                data-testid="viewer-hydrophobicity"
                onClick={() => setShowHydrophobicity((prev) => !prev)}
                className={`shrink-0 rounded-full px-2.5 py-2 text-xs font-medium transition sm:text-sm ${
                  showHydrophobicity
                    ? 'bg-orange-400 text-slate-950'
                    : 'bg-white/5 text-slate-300 hover:bg-white/10'
                }`}
                title="Hydrophobicity coloring (orange=hydrophobic, blue=hydrophilic)"
              >
                Hydrophobicity
              </button>

              <button
                data-testid="viewer-color-by-aa-class"
                onClick={() => setColorByAAClass((prev) => !prev)}
                className={`shrink-0 rounded-full px-2.5 py-2 text-xs font-medium transition sm:text-sm ${
                  colorByAAClass
                    ? 'bg-violet-400 text-slate-950'
                    : 'bg-white/5 text-slate-300 hover:bg-white/10'
                }`}
                title="Color Cα spheres by amino-acid physicochemical class (A to toggle)"
              >
                AA Class
              </button>

              <button
                data-testid="viewer-color-by-chain"
                onClick={() => setColorByChain((prev) => !prev)}
                className={`shrink-0 rounded-full px-2.5 py-2 text-xs font-medium transition sm:text-sm ${
                  colorByChain
                    ? 'bg-emerald-500 text-white'
                    : 'bg-white/5 text-slate-300 hover:bg-white/10'
                }`}
                title="Toggle chain-based coloring"
              >
                Chains
              </button>

              <button
                onClick={resetView}
                className="shrink-0 rounded-full bg-white/5 px-2.5 py-2 text-xs font-medium text-slate-300 transition hover:bg-white/10 sm:text-sm"
              >
                Reset view
              </button>

              <button
                data-testid="viewer-focus-selection"
                onClick={focusSelection}
                className="shrink-0 rounded-full bg-white/5 px-2.5 py-2 text-xs font-medium text-slate-300 transition hover:bg-white/10 sm:text-sm"
              >
                Center
              </button>

              <button
                data-testid="viewer-auto-rotate"
                onClick={() => setAutoRotate((prev) => !prev)}
                className={`shrink-0 rounded-full px-2.5 py-2 text-xs font-medium transition sm:text-sm ${
                  autoRotate
                    ? 'bg-emerald-400 text-slate-950'
                    : 'bg-white/5 text-slate-300 hover:bg-white/10'
                }`}
              >
                {autoRotate ? 'Rotate on' : 'Rotate off'}
              </button>

              <button
                data-testid="viewer-snapshot"
                onClick={downloadSnapshot}
                className="shrink-0 rounded-full bg-white/5 px-2.5 py-2 text-xs font-medium text-slate-300 transition hover:bg-white/10 sm:text-sm"
              >
                Save PNG
              </button>

              <button
                data-testid="viewer-download-pdb"
                onClick={downloadPDB}
                className="shrink-0 rounded-full bg-white/5 px-2.5 py-2 text-xs font-medium text-slate-300 transition hover:bg-white/10 sm:text-sm"
              >
                PDB
              </button>

              <button
                data-testid="viewer-show-labels"
                onClick={() => setShowLabels((prev) => !prev)}
                className={`shrink-0 rounded-full px-2.5 py-2 text-xs font-medium transition sm:text-sm ${
                  showLabels
                    ? 'bg-cyan-400/20 text-cyan-100'
                    : 'bg-white/5 text-slate-300 hover:bg-white/10'
                }`}
                title="Toggle residue label overlays"
              >
                Labels {showLabels ? 'on' : 'off'}
              </button>

              <button
                data-testid="viewer-fullscreen"
                onClick={() => setIsFullscreen((prev) => !prev)}
                className={`shrink-0 rounded-full px-3 py-2 text-sm font-medium transition ${
                  isFullscreen
                    ? 'bg-slate-400 text-slate-950'
                    : 'bg-white/5 text-slate-300 hover:bg-white/10'
                }`}
                title={isFullscreen ? 'Restore split view' : 'Expand 3D canvas'}
              >
                {isFullscreen ? 'Restore' : 'Expand'}
              </button>

            </div>

            <div
              data-testid="viewer-shortcut-hints"
              className="border-b border-white/10 px-4 pb-3 text-xs text-slate-400"
            >
              Rotate: drag · Zoom: scroll · Select: click · Shift/Ctrl-click: add/remove · Hover: inspect · / focus · F fullscreen · C chains · L labels · H heatmap · Y hydrophobicity · A AA class
            </div>

            <div className="grid gap-3 border-b border-white/10 px-4 py-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Atoms" value={String(residueStats.atoms)} />
              <StatCard label="Residues" value={String(residueStats.visibleResidues)} />
              <StatCard label="Chains" value={String(residueStats.chains)} />
              <StatCard
                label="Avg B-factor"
                value={parsed.bFactorRange.average ? parsed.bFactorRange.average.toFixed(1) : '0.0'}
              />
            </div>

            {secondaryStructureComposition && (
              <div
                data-testid="viewer-ss-composition"
                className="border-b border-white/10 px-4 py-3"
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Secondary structure
                    </div>
                    {visibleResidues.filter((r) => r.caAtom).length < 5 ? (
                      <span className="text-[11px] italic text-slate-500">too few residues</span>
                    ) : (
                      <button
                        type="button"
                        data-testid="viewer-ss-copy-fasta"
                        onClick={async () => {
                          const THREE_TO_ONE_LOCAL: Record<string, string> = { ALA:'A',ARG:'R',ASN:'N',ASP:'D',CYS:'C',GLN:'Q',GLU:'E',GLY:'G',HIS:'H',ILE:'I',LEU:'L',LYS:'K',MET:'M',PHE:'F',PRO:'P',SER:'S',THR:'T',TRP:'W',TYR:'Y',VAL:'V' }
                          const seq = visibleResidues.map((r) => r.residue.length === 3 ? (THREE_TO_ONE_LOCAL[r.residue] ?? r.residue[0] ?? '?') : r.residue[0] ?? '?').join('')
                          if (seq) {
                            await copyTextToClipboard(`>Structure_${seq.length}aa\n${seq}`)
                            setAnalysisMessage(`Copied full sequence FASTA (${seq.length} residues).`)
                          }
                        }}
                        className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-slate-300 transition hover:bg-white/10"
                        title="Copy full visible sequence as FASTA"
                      >
                        Copy FASTA
                      </button>
                    )}
                  </div>
                  {visibleResidues.filter((r) => r.caAtom).length >= 5 && (
                    <>
                      <div
                        data-testid="viewer-ss-bar"
                        className="flex h-2.5 w-full overflow-hidden rounded-full"
                        title={`Helix ${secondaryStructureComposition.helix}% · Sheet ${secondaryStructureComposition.sheet}% · Turn ${secondaryStructureComposition.turn}% · Coil ${secondaryStructureComposition.coil}%`}
                      >
                        {secondaryStructureComposition.helix > 0 && <div className="bg-rose-500/80" style={{ width: `${secondaryStructureComposition.helix}%` }} />}
                        {secondaryStructureComposition.sheet > 0 && <div className="bg-yellow-500/80" style={{ width: `${secondaryStructureComposition.sheet}%` }} />}
                        {secondaryStructureComposition.turn > 0 && <div className="bg-cyan-500/80" style={{ width: `${secondaryStructureComposition.turn}%` }} />}
                        {secondaryStructureComposition.coil > 0 && <div className="bg-slate-500/70" style={{ width: `${secondaryStructureComposition.coil}%` }} />}
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                        <span className="flex items-center gap-1">
                          <span className="inline-block h-2 w-2 rounded-full bg-rose-400" />
                          Helix {secondaryStructureComposition.helix}%
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="inline-block h-2 w-2 rounded-full bg-yellow-400" />
                          Sheet {secondaryStructureComposition.sheet}%
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="inline-block h-2 w-2 rounded-full bg-cyan-400" />
                          Turn {secondaryStructureComposition.turn}%
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="inline-block h-2 w-2 rounded-full bg-slate-400" />
                          Coil {secondaryStructureComposition.coil}%
                        </span>
                      </div>
                    </>
                  )}
                </div>
                {/* Per-residue sequence strip replaces the aggregate bar */}
                {visibleResidues.filter((r) => r.caAtom).length >= 5 ? (
                  <>
                    <div data-testid="viewer-ss-helix-bar" className="hidden" />
                    <div data-testid="viewer-ss-sheet-bar" className="hidden" />
                    <div data-testid="viewer-ss-turn-bar" className="hidden" />
                    <div data-testid="viewer-ss-coil-bar" className="hidden" />
                    <div
                      data-testid="viewer-sequence-strip"
                      className="mt-2 flex items-center gap-px overflow-x-auto pb-0.5"
                      style={{ scrollbarWidth: 'thin' }}
                      title="Per-residue sequence strip — colored by secondary structure · click to select"
                    >
                      {(() => {
                        const elements: React.ReactNode[] = []
                        const THREE_TO_ONE: Record<string, string> = { ALA:'A',ARG:'R',ASN:'N',ASP:'D',CYS:'C',GLN:'Q',GLU:'E',GLY:'G',HIS:'H',ILE:'I',LEU:'L',LYS:'K',MET:'M',PHE:'F',PRO:'P',SER:'S',THR:'T',TRP:'W',TYR:'Y',VAL:'V' }
                        let lastChain: string | null = null
                        for (const residue of visibleResidues) {
                          if (lastChain !== null && lastChain !== residue.chain) {
                            elements.push(
                              <div key={`sep-${lastChain}-${residue.chain}`} className="mx-1 flex h-5 shrink-0 items-center">
                                <div className="h-3 w-px bg-white/20" />
                                <span className="ml-0.5 text-[8px] font-bold text-slate-500">{residue.chain}</span>
                              </div>
                            )
                          } else if (lastChain === null) {
                            elements.push(
                              <span key={`chain-label-${residue.chain}`} className="mr-0.5 text-[8px] font-bold text-slate-500">{residue.chain}</span>
                            )
                          }
                          lastChain = residue.chain
                          const oneLetterCode = residue.residue.length === 3
                            ? (THREE_TO_ONE[residue.residue] ?? residue.residue[0])
                            : residue.residue[0] ?? '?'
                          const ssType = residueSSTypes.get(residue.key) ?? 'coil'
                          const isSelected = selectedResidues.some((s) => s.chain === residue.chain && s.residueNum === residue.residueNum)
                          const ssColorClass = isSelected
                            ? 'bg-cyan-400 text-slate-950'
                            : ssType === 'helix' ? 'bg-rose-500/60 text-rose-50'
                            : ssType === 'sheet' ? 'bg-yellow-500/60 text-yellow-50'
                            : ssType === 'turn' ? 'bg-cyan-500/50 text-cyan-50'
                            : 'bg-slate-700/60 text-slate-300'
                          elements.push(
                            <button
                              key={residue.key}
                              type="button"
                              data-testid={`viewer-strip-${residue.chain}-${residue.residueNum}`}
                              onClick={(event) =>
                                handleResidueTokenClick(event, {
                                  chain: residue.chain,
                                  residueNum: residue.residueNum,
                                  residue: residue.residue,
                                })
                              }
                              title={`${residue.chain}:${residue.residueNum} ${residue.residue} (${ssType}) · B-factor: ${residue.avgBFactor.toFixed(1)} · Shift/Ctrl-click to add/remove`}
                              className={`flex h-5 w-4 shrink-0 items-center justify-center rounded-[3px] text-[9px] font-bold transition hover:brightness-125 ${ssColorClass}`}
                            >
                              {oneLetterCode}
                            </button>
                          )
                        }
                        return elements
                      })()}
                    </div>
                  </>
                ) : (
                  <div className="mt-2 h-3 w-full rounded-full bg-white/5" />
                )}
              </div>
            )}

            {selectionSummary && (
              <div
                ref={selectionSpotlightRef}
                data-testid="viewer-selection-spotlight"
                className="border-b border-emerald-400/10 bg-emerald-500/10 px-4 py-3"
              >
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-100">
                        Selection spotlight
                      </div>
                      <div
                        data-testid="viewer-selection-spotlight-primary"
                        className="mt-1 text-base font-semibold text-white"
                      >
                        {formatResidueSelection(selectionSummary.primary)}
                      </div>
                      <div className="mt-1 text-xs text-emerald-100/80">
                        Keep the latest residue context visible while exploring the structure.
                      </div>
                    </div>
                    <span className="rounded-full border border-white/10 bg-slate-950/40 px-2.5 py-1 text-[11px] font-medium text-emerald-50">
                      {selectionSummary.count} selected
                    </span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                    <InspectorStat
                      label="Atom count"
                      value={String(selectionSummary.primary.atomCount)}
                      testId="viewer-selection-spotlight-atom-count"
                    />
                    <InspectorStat
                      label="Avg B-factor"
                      value={selectionSummary.primary.avgBFactor.toFixed(1)}
                      testId="viewer-selection-spotlight-bfactor"
                    />
                    <InspectorStat
                      label="Sequence residue"
                      value={selectionSummary.primary.sequenceResidue || 'n/a'}
                      testId="viewer-selection-spotlight-sequence"
                    />
                    <InspectorStat
                      label="Selected range"
                      value={selectionSummary.ranges}
                      testId="viewer-selection-spotlight-range"
                    />
                  </div>

                  {selectionSummary.count === 2 && (
                    <div
                      data-testid="viewer-distance-card"
                      className="rounded-2xl border border-amber-400/25 bg-amber-400/10 p-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-100">
                          Distance measurement
                        </div>
                        <button
                          type="button"
                          data-testid="viewer-distance-copy"
                          onClick={copyFarthestPair}
                          className="rounded-full border border-amber-300/20 bg-amber-300/10 px-2.5 py-1 text-[11px] font-medium text-amber-50 transition hover:bg-amber-300/15"
                        >
                          Copy
                        </button>
                      </div>
                      <div
                        data-testid="viewer-distance-value"
                        className="mt-2 text-2xl font-bold tabular-nums text-white"
                      >
                        {selectionSummary.maxDistance.toFixed(1)}
                        <span className="ml-1 text-base font-normal text-amber-100">Å</span>
                      </div>
                      <div className="mt-1 text-xs text-amber-100/75">
                        Cα–Cα span between the two selected residues
                      </div>
                    </div>
                  )}
                  {selectionSummary.count === 3 && selectionSummary.tripletsAngleDeg !== null && (
                    <div
                      data-testid="viewer-angle-card"
                      className="rounded-2xl border border-sky-400/25 bg-sky-400/10 p-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-sky-100">
                          Angle measurement
                        </div>
                        <span className="rounded-full border border-sky-300/20 bg-sky-300/10 px-2.5 py-1 text-[11px] font-medium text-sky-50">
                          3 residues
                        </span>
                      </div>
                      <div
                        data-testid="viewer-angle-value"
                        className="mt-2 text-2xl font-bold tabular-nums text-white"
                      >
                        {selectionSummary.tripletsAngleDeg.toFixed(1)}
                        <span className="ml-1 text-base font-normal text-sky-100">°</span>
                      </div>
                      <div className="mt-1 text-xs text-sky-100/75">
                        Cα–Cα–Cα bond angle at the middle residue
                      </div>
                    </div>
                  )}
                  {selectedResidueDetails.length > 1 && (
                    <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-100">
                            Selection navigator
                          </div>
                          <div className="mt-1 text-xs text-emerald-100/75">
                            Cycle or jump between selected residues without leaving the viewer.
                          </div>
                        </div>
                        <span
                          data-testid="viewer-selection-spotlight-index"
                          className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-emerald-50"
                        >
                          {primarySelectionIndex + 1} / {selectedResidueDetails.length}
                        </span>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          data-testid="viewer-selection-spotlight-prev"
                          onClick={() => cycleSpotlightSelection(-1)}
                          className="rounded-full border border-white/10 bg-white/10 px-3 py-1.5 text-xs font-medium text-slate-50 transition hover:bg-white/15"
                        >
                          Previous
                        </button>
                        <button
                          type="button"
                          data-testid="viewer-selection-spotlight-next"
                          onClick={() => cycleSpotlightSelection(1)}
                          className="rounded-full border border-white/10 bg-white/10 px-3 py-1.5 text-xs font-medium text-slate-50 transition hover:bg-white/15"
                        >
                          Next
                        </button>
                      </div>
                      <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                        {selectedResidueDetails.map((detail) => {
                          const active =
                            detail.chain === selectionSummary.primary.chain &&
                            detail.residueNum === selectionSummary.primary.residueNum
                          return (
                            <button
                              key={`spotlight-${detail.chain}-${detail.residueNum}`}
                              type="button"
                              data-testid={`viewer-selection-spotlight-chip-${detail.chain}-${detail.residueNum}`}
                              onClick={() =>
                                focusSelectionFromSpotlight({
                                  chain: detail.chain,
                                  residueNum: detail.residueNum,
                                  residue: detail.residue,
                                })
                              }
                              className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                                active
                                  ? 'border-emerald-300/40 bg-emerald-400/20 text-emerald-50'
                                  : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'
                              }`}
                            >
                              {formatResidueSelection(detail)}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  <div className="grid gap-2 sm:grid-cols-2 xl:flex xl:flex-wrap">
                    <button
                      type="button"
                      data-testid="viewer-selection-spotlight-center"
                      onClick={focusSelection}
                      className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-slate-50 transition hover:bg-white/15"
                    >
                      Center selection
                    </button>
                    <button
                      type="button"
                      data-testid="viewer-selection-spotlight-copy"
                      onClick={copySelectedResidues}
                      className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-slate-50 transition hover:bg-white/15"
                    >
                      Copy residues
                    </button>
                    {sequence && (
                      <button
                        type="button"
                        data-testid="viewer-selection-spotlight-fasta"
                        onClick={copySelectedFasta}
                        className="rounded-xl border border-emerald-200/20 bg-emerald-300/10 px-3 py-2 text-sm font-medium text-emerald-50 transition hover:bg-emerald-300/15"
                      >
                        Copy FASTA
                      </button>
                    )}
                    <button
                      type="button"
                      data-testid="viewer-selection-spotlight-nearby"
                      onClick={selectNearbyResiduesFromSpotlight}
                      aria-label={`Select nearby residues within ${formatAngstrom(neighborRadiusAngstrom)} angstroms`}
                      className="rounded-xl border border-emerald-200/20 bg-emerald-300/10 px-3 py-2 text-sm font-medium text-emerald-50 transition hover:bg-emerald-300/15"
                    >
                      Nearby (≤{formatAngstrom(neighborRadiusAngstrom)} Å)
                    </button>
                    <button
                      type="button"
                      data-testid="viewer-selection-spotlight-inspector"
                      onClick={scrollToResidueInspector}
                      className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-slate-50 transition hover:bg-white/15"
                    >
                      Open inspector
                    </button>
                    <button
                      type="button"
                      data-testid="viewer-selection-spotlight-clear"
                      onClick={clearSelection}
                      className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-slate-50 transition hover:bg-white/15"
                    >
                      Clear selection
                    </button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_96px]">
                    <label className="block text-xs font-medium uppercase tracking-wide text-emerald-100/80">
                      Nearby radius (Å)
                      <input
                        type="range"
                        min={MIN_SPOTLIGHT_NEIGHBOR_RADIUS}
                        max={MAX_SPOTLIGHT_NEIGHBOR_RADIUS}
                        step={0.5}
                        value={neighborRadiusAngstrom}
                        data-testid="viewer-selection-neighbor-radius-range"
                        onChange={(event) => updateNeighborRadius(Number(event.target.value))}
                        className="mt-2 h-1.5 w-full cursor-pointer accent-emerald-300"
                      />
                    </label>
                    <label className="block text-xs font-medium uppercase tracking-wide text-emerald-100/80">
                      Value
                      <input
                        type="number"
                        min={MIN_SPOTLIGHT_NEIGHBOR_RADIUS}
                        max={MAX_SPOTLIGHT_NEIGHBOR_RADIUS}
                        step={0.5}
                        value={neighborRadiusAngstrom}
                        data-testid="viewer-selection-neighbor-radius"
                        onChange={(event) => updateNeighborRadius(Number.parseFloat(event.target.value))}
                        className="mt-1.5 w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm normal-case tracking-normal text-slate-100 outline-none focus:border-emerald-300/50"
                      />
                    </label>
                  </div>
                </div>
              </div>
            )}

            {workflowSummary && (
              <div
                ref={analysisRibbonRef}
                data-testid="viewer-analysis-ribbon"
                className="border-b border-cyan-400/10 bg-cyan-400/10 px-4 py-3"
              >
                <div className="flex flex-col gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-cyan-300/20 bg-slate-950/30 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-cyan-50">
                        Active analysis
                      </span>
                      <span className="text-xs font-medium text-cyan-100">
                        {workflowSummary.residueCount} selected · Chains {workflowSummary.chains}
                      </span>
                    </div>
                    <div className="mt-2 text-sm text-slate-100">
                      Positions{' '}
                      <span data-testid="viewer-analysis-positions" className="font-semibold text-white">
                        {workflowSummary.positionsLabel}
                      </span>{' '}
                      · Latest{' '}
                      <span data-testid="viewer-analysis-latest" className="font-semibold text-white">
                        {workflowSummary.latestResidue}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {selectedResidues.slice(-4).map((selection) => (
                      <button
                        key={`analysis-${selection.chain}-${selection.residueNum}`}
                        type="button"
                        data-testid={`viewer-analysis-chip-${selection.chain}-${selection.residueNum}`}
                        onClick={() => focusSelectionEntry(selection)}
                        className="rounded-full border border-cyan-300/25 bg-slate-950/35 px-2.5 py-1.5 text-xs font-medium text-cyan-50 transition hover:bg-slate-950/55"
                      >
                        {formatResidueSelection(selection)}
                      </button>
                    ))}
                    {selectedResidues.length > 4 && (
                      <span className="rounded-full border border-white/10 bg-slate-950/25 px-2.5 py-1.5 text-xs text-cyan-100/80">
                        +{selectedResidues.length - 4} more
                      </span>
                    )}
                  </div>

                  {sequence && (
                    <div className="rounded-2xl border border-cyan-300/15 bg-slate-950/30 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-cyan-100">
                            Quick mutation start
                          </div>
                          <div className="mt-1 text-xs text-cyan-100/75">
                            These controls stay synced with the detailed variant workspace below.
                          </div>
                        </div>
                        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-cyan-50">
                          {parsedVariantPositions.length || 0} position{parsedVariantPositions.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px]">
                        <label className="block text-xs font-medium uppercase tracking-wide text-cyan-100/80">
                          Positions
                          <input
                            aria-label="Quick variant positions"
                            data-testid="viewer-analysis-positions-input"
                            value={positionsText}
                            onChange={(event) => setPositionsText(event.target.value)}
                            placeholder="e.g. 9,10,28"
                            className="mt-1.5 w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm normal-case tracking-normal text-slate-100 outline-none focus:border-cyan-400/50"
                          />
                        </label>
                        <label className="block text-xs font-medium uppercase tracking-wide text-cyan-100/80">
                          Variants
                          <input
                            aria-label="Quick number of variants"
                            data-testid="viewer-analysis-num-variants"
                            type="number"
                            min={1}
                            max={20}
                            value={numVariants}
                            onChange={(event) => updateNumVariants(Number(event.target.value))}
                            className="mt-1.5 w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm normal-case tracking-normal text-slate-100 outline-none focus:border-cyan-400/50"
                          />
                        </label>
                      </div>
                    </div>
                  )}

                  <div className="grid gap-2 sm:grid-cols-2 xl:flex xl:flex-wrap">
                    <button
                      data-testid="viewer-analysis-details"
                      onClick={scrollToDetailedAnalysis}
                      className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-slate-50 transition hover:bg-white/15"
                    >
                      Open details
                    </button>
                    {sequence && (
                      <button
                        data-testid="viewer-analysis-jump-variants"
                        onClick={scrollToVariantProposal}
                        className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-slate-50 transition hover:bg-white/15"
                      >
                        Jump to variants
                      </button>
                    )}
                    <button
                      data-testid="viewer-analysis-center"
                      onClick={focusSelection}
                      className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-slate-50 transition hover:bg-white/15"
                    >
                      Center selection
                    </button>
                    <button
                      data-testid="viewer-analysis-copy"
                      onClick={copySelectedPositions}
                      className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-slate-50 transition hover:bg-white/15"
                    >
                      Copy positions
                    </button>
                    <button
                      data-testid="viewer-analysis-copy-residues"
                      onClick={copySelectedResidues}
                      className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-slate-50 transition hover:bg-white/15"
                    >
                      Copy residues
                    </button>
                    {sequence ? (
                      <button
                        data-testid="viewer-analysis-propose"
                        onClick={callProposeVariants}
                        disabled={variantsRunning}
                        className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
                          variantsRunning
                            ? 'bg-slate-700 text-slate-300'
                            : 'bg-violet-500 text-white hover:bg-violet-400'
                        }`}
                      >
                        {variantsRunning ? 'Proposing…' : `Propose ${numVariants} variants`}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            )}

            {proposedVariants.length > 0 && (
              <div
                data-testid="viewer-variant-spotlight"
                className="border-b border-violet-400/10 bg-violet-500/10 px-4 py-3"
              >
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-violet-100">
                        Variant spotlight
                      </div>
                      <div className="mt-1 text-xs text-violet-100/80">
                        Keep the top proposal actionable next to the 3D viewer.
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-full border border-white/10 bg-slate-950/40 px-2.5 py-1 text-[11px] font-medium text-violet-50">
                        {proposedVariants.length} result{proposedVariants.length === 1 ? '' : 's'}
                      </span>
                      <button
                        type="button"
                        data-testid="viewer-variant-spotlight-open-results"
                        onClick={scrollToVariantResults}
                        className="rounded-full border border-white/10 bg-white/10 px-2.5 py-1 text-[11px] font-medium text-violet-50 transition hover:bg-white/15"
                      >
                        Open full list
                      </button>
                    </div>
                  </div>
                  <div className="grid gap-2 xl:grid-cols-2">
                    {proposedVariants.slice(0, 2).map((variant, index) => (
                      <div
                        key={`spotlight-${variant.sequence || index}`}
                        data-testid={`viewer-variant-spotlight-card-${index}`}
                        className="rounded-2xl border border-white/10 bg-slate-950/55 p-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-xs font-semibold uppercase tracking-wide text-violet-100/70">
                            Candidate {index + 1}
                          </div>
                          <div
                            data-testid={`viewer-variant-spotlight-score-${index}`}
                            className="text-sm font-semibold text-violet-50"
                          >
                            {typeof variant.score === 'number' ? variant.score : 'n/a'}
                          </div>
                        </div>
                        <div
                          data-testid={`viewer-variant-spotlight-sequence-${index}`}
                          className="mt-2 break-all font-mono text-xs text-slate-100"
                        >
                          {String(variant.sequence ?? '')}
                        </div>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          {typeof variant.sequence === 'string' && onUseSequence && (
                            <button
                              type="button"
                              data-testid={`viewer-variant-spotlight-iterate-${index}`}
                              onClick={() => iterateWithVariant(variant)}
                              className="rounded-xl bg-cyan-400 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300"
                            >
                              Iterate
                            </button>
                          )}
                          {typeof variant.sequence === 'string' && (
                            <button
                              type="button"
                              data-testid={`viewer-variant-spotlight-save-${index}`}
                              onClick={() => saveVariantToLibrary(variant)}
                              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/10"
                            >
                              Save
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="h-[460px] bg-slate-950/60 sm:h-[560px] lg:min-h-0 lg:flex-1">
              {error ? (
                <div className="flex h-full items-center justify-center px-6 text-center">
                  <div>
                    <div className="mb-3 text-5xl">⚠️</div>
                    <p className="text-lg font-medium text-rose-300">{error}</p>
                  </div>
                </div>
              ) : (
                <div className="relative h-full w-full">
                  <div ref={containerRef} className="h-full w-full" />

                  {/* B-factor heatmap legend */}
                  {showHeatmap && (
                    <div
                      data-testid="viewer-heatmap-legend"
                      className="pointer-events-none absolute bottom-4 left-4 rounded-2xl border border-white/10 bg-slate-950/80 px-3 py-2 text-xs text-slate-200 backdrop-blur-sm"
                    >
                      <div className="mb-1.5 font-semibold uppercase tracking-wide text-slate-400">B-factor scale</div>
                      <div
                        className="h-3 w-28 rounded-full"
                        style={{ background: 'linear-gradient(to right, #3b82f6, #22c55e, #ef4444)' }}
                      />
                      <div className="mt-1 flex justify-between font-mono">
                        <span>{parsed.bFactorRange.min.toFixed(0)}</span>
                        <span>{parsed.bFactorRange.average.toFixed(0)}</span>
                        <span>{parsed.bFactorRange.max.toFixed(0)}</span>
                      </div>
                      <div className="mt-0.5 flex justify-between text-[10px] text-slate-500">
                        <span>ordered</span>
                        <span>disordered</span>
                      </div>
                    </div>
                  )}

                  {/* Chain color legend overlay */}
                  {colorByChain && !showHeatmap && !showHydrophobicity && !colorByAAClass && parsed.chains.length > 1 && (
                    <div
                      data-testid="viewer-chain-legend-overlay"
                      className="pointer-events-none absolute bottom-4 right-4 rounded-2xl border border-white/10 bg-slate-950/80 px-3 py-2 text-xs backdrop-blur-sm"
                    >
                      <div className="mb-1.5 font-semibold uppercase tracking-wide text-slate-400">Chains</div>
                      <div className="space-y-1">
                        {parsed.chains.map((chain, i) => (
                          <div key={chain} className="flex items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: `#${new THREE.Color(CHAIN_PALETTE[i % CHAIN_PALETTE.length]).getHexString()}` }}
                            />
                            <span className="text-slate-200">Chain {chain}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* AA class legend overlay */}
                  {colorByAAClass && !showHeatmap && !showHydrophobicity && (
                    <div
                      data-testid="viewer-aa-class-legend-overlay"
                      className="pointer-events-none absolute bottom-4 right-4 rounded-2xl border border-white/10 bg-slate-950/80 px-3 py-2 text-xs backdrop-blur-sm"
                    >
                      <div className="mb-1.5 font-semibold uppercase tracking-wide text-slate-400">AA Class</div>
                      <div className="space-y-1">
                        {[
                          { label: 'Hydrophobic', color: '#94a3b8' },
                          { label: 'Polar', color: '#2dd4bf' },
                          { label: 'Negative', color: '#fb7185' },
                          { label: 'Positive', color: '#60a5fa' },
                          { label: 'Gly / Pro', color: '#86efac' },
                        ].map(({ label, color }) => (
                          <div key={label} className="flex items-center gap-2">
                            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                            <span className="text-slate-200">{label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Selection count badge */}
                  {selectedResidues.length > 0 && (
                    <div
                      data-testid="viewer-selection-count-badge"
                      className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-cyan-400/30 bg-slate-950/80 px-4 py-1.5 text-xs font-semibold text-cyan-200 backdrop-blur-sm"
                    >
                      {selectedResidues.length} residue{selectedResidues.length === 1 ? '' : 's'} selected
                    </div>
                  )}

                  {/* Hover residue tooltip */}
                  {hoverInfo && (
                    <div
                      data-testid="viewer-hover-tooltip"
                      className="pointer-events-none absolute z-10 rounded-xl border border-white/10 bg-slate-900/90 px-3 py-1.5 text-xs font-medium text-slate-100 backdrop-blur-sm"
                      style={{ left: hoverInfo.x + 12, top: hoverInfo.y - 10 }}
                    >
                      {hoverInfo.label}
                    </div>
                  )}

                  {hoverInfo && (
                    <div
                      data-testid="viewer-hover-spotlight"
                      onMouseEnter={cancelHoverClear}
                      onMouseLeave={() => setHoverInfo(null)}
                      className="absolute right-4 top-4 z-10 w-64 rounded-2xl border border-cyan-400/20 bg-slate-950/90 p-4 shadow-lg shadow-slate-950/30 backdrop-blur-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200">
                            Hover spotlight
                          </div>
                          <div data-testid="viewer-hover-spotlight-label" className="mt-1 text-sm font-semibold text-white">
                            {hoverInfo.label}
                          </div>
                          {AA_FULL_NAMES[hoverInfo.residue.toUpperCase()] && (
                            <div className="mt-0.5 text-xs text-slate-400">
                              {AA_FULL_NAMES[hoverInfo.residue.toUpperCase()]}
                            </div>
                          )}
                        </div>
                        <div className="rounded-full bg-white/10 px-2 py-1 text-[11px] font-medium text-slate-300">
                          {hoverInfo.atomCount} atoms
                        </div>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-300">
                        <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                          <div className="text-[10px] uppercase tracking-wide text-slate-500">Avg B-factor</div>
                          <div data-testid="viewer-hover-spotlight-bfactor" className="mt-1 font-semibold text-white">
                            {hoverInfo.avgBFactor.toFixed(1)}
                          </div>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                          <div className="text-[10px] uppercase tracking-wide text-slate-500">Sequence</div>
                          <div data-testid="viewer-hover-spotlight-sequence" className="mt-1 font-semibold text-white">
                            {hoverInfo.sequenceResidue || 'n/a'}
                          </div>
                        </div>
                        {(() => {
                          const ssType = residueSSTypes.get(residueKey(hoverInfo.chain, hoverInfo.residueNum))
                          if (!ssType) return null
                          const ssHex = ssType === 'helix' ? '#fb7185' : ssType === 'sheet' ? '#facc15' : ssType === 'turn' ? '#22d3ee' : '#94a3b8'
                          return (
                            <div className="col-span-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                              <div className="text-[10px] uppercase tracking-wide text-slate-500">Structure type</div>
                              <div className="mt-1 flex items-center gap-1.5">
                                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ssHex }} />
                                <span className="font-semibold capitalize text-white">{ssType}</span>
                              </div>
                            </div>
                          )
                        })()}
                        {HYDROPHOBICITY_SCALE[hoverInfo.residue.toUpperCase()] !== undefined && (
                          <div className="col-span-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                            <div className="text-[10px] uppercase tracking-wide text-slate-500">Hydrophobicity</div>
                            <div className="mt-1 flex items-center gap-2">
                              <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
                                <div
                                  className="h-full rounded-full"
                                  style={{
                                    width: `${((HYDROPHOBICITY_SCALE[hoverInfo.residue.toUpperCase()] - HYDRO_MIN) / (HYDRO_MAX - HYDRO_MIN)) * 100}%`,
                                    background: 'linear-gradient(to right, #60a5fa, #fb923c)',
                                  }}
                                />
                              </div>
                              <span className="shrink-0 font-semibold text-white">
                                {HYDROPHOBICITY_SCALE[hoverInfo.residue.toUpperCase()].toFixed(2)}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                      <p className="mt-3 text-xs leading-5 text-slate-400">
                        Hover reveals residue context before you commit it to the active structural analysis set.
                      </p>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <button
                          type="button"
                          data-testid="viewer-hover-spotlight-toggle"
                          onClick={toggleHoveredResidue}
                          className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
                            isHoveredResidueSelected
                              ? 'border border-rose-400/30 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20'
                              : 'bg-cyan-400 text-slate-950 hover:bg-cyan-300'
                          }`}
                        >
                          {isHoveredResidueSelected ? 'Remove from selection' : 'Add to selection'}
                        </button>
                        <button
                          type="button"
                          data-testid="viewer-hover-spotlight-focus"
                          onClick={focusHoveredResidue}
                          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/10"
                        >
                          Focus residue
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Residue label overlays for selected residues */}
                  {showLabels && labelOverlays.map((overlay) => (
                    <div
                      key={overlay.key}
                      className="pointer-events-none absolute z-10 select-none rounded-full border px-1.5 py-0.5 text-[10px] font-bold backdrop-blur-sm"
                      style={{
                        left: overlay.x + 6,
                        top: overlay.y - 14,
                        borderColor: overlay.color,
                        background: `${overlay.color}22`,
                        color: overlay.color,
                        textShadow: '0 1px 2px #000',
                      }}
                    >
                      {overlay.label}
                    </div>
                  ))}

                  {/* Distance / angle line overlay when 2 or 3 residues are selected */}
                  {labelOverlays.length >= 2 && labelOverlays.length <= 3 && (
                    <svg
                      data-testid="viewer-measure-overlay"
                      className="pointer-events-none absolute inset-0 h-full w-full"
                      style={{ overflow: 'visible' }}
                    >
                      {labelOverlays.length === 2 && (
                        <line
                          x1={labelOverlays[0].x}
                          y1={labelOverlays[0].y}
                          x2={labelOverlays[1].x}
                          y2={labelOverlays[1].y}
                          stroke="#f59e0b"
                          strokeWidth="1.5"
                          strokeDasharray="5 3"
                          strokeOpacity="0.75"
                        />
                      )}
                      {labelOverlays.length === 3 && (
                        <>
                          <line
                            x1={labelOverlays[0].x}
                            y1={labelOverlays[0].y}
                            x2={labelOverlays[1].x}
                            y2={labelOverlays[1].y}
                            stroke="#38bdf8"
                            strokeWidth="1.5"
                            strokeDasharray="5 3"
                            strokeOpacity="0.7"
                          />
                          <line
                            x1={labelOverlays[1].x}
                            y1={labelOverlays[1].y}
                            x2={labelOverlays[2].x}
                            y2={labelOverlays[2].y}
                            stroke="#38bdf8"
                            strokeWidth="1.5"
                            strokeDasharray="5 3"
                            strokeOpacity="0.7"
                          />
                          <circle
                            cx={labelOverlays[1].x}
                            cy={labelOverlays[1].y}
                            r="4"
                            fill="#38bdf8"
                            fillOpacity="0.5"
                          />
                        </>
                      )}
                    </svg>
                  )}
                </div>
              )}
            </div>
          </div>

          <aside className={`min-w-0 bg-slate-900/95 p-4 lg:flex lg:min-h-0 lg:flex-col lg:overflow-y-auto ${isFullscreen ? 'hidden' : ''}`}>
            <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Structure controls</h4>
              <div className="mt-4 space-y-3">
                <label className="block text-sm text-slate-300">
                  Chain filter
                  <select
                    data-testid="viewer-chain-filter"
                    value={selectedChain}
                    onChange={(event) => setSelectedChain(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/50"
                  >
                    <option value="all">All chains</option>
                    {parsed.chains.map((chain) => (
                      <option key={chain} value={chain}>
                        Chain {chain}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block text-sm text-slate-300">
                  Focus / Select residue
                  <div className="mt-2 flex gap-2">
                    <input
                      ref={focusResidueInputRef}
                      data-testid="viewer-focus-residue"
                      value={focusResidue}
                      onChange={(event) => setFocusResidue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          focusOnResidue()
                        }
                      }}
                      placeholder="e.g. 42, A:42, or A:1-20"
                      className="min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/50"
                    />
                    <button
                      data-testid="viewer-focus-button"
                      onClick={focusOnResidue}
                      className="rounded-xl bg-cyan-400 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300"
                    >
                      Go
                    </button>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500">Range: A:1-20 selects all residues in that range</p>
                </label>

                <div className="grid gap-2 sm:grid-cols-3">
                  <button
                    data-testid="viewer-hotspots-3"
                    onClick={() => selectHotspots(3)}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10"
                  >
                    Top 3 hotspots
                  </button>
                  <button
                    data-testid="viewer-hotspots-5"
                    onClick={() => selectHotspots(5)}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10"
                  >
                    Top 5 hotspots
                  </button>
                  <button
                    data-testid="viewer-copy-positions"
                    onClick={copySelectedPositions}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10"
                  >
                    Copy positions
                  </button>
                  <button
                    data-testid="viewer-copy-residues"
                    onClick={copySelectedResidues}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10"
                  >
                    Copy residues
                  </button>
                </div>

                {parsed.chains.length >= 2 && (
                  <button
                    data-testid="viewer-interface-contacts"
                    onClick={selectBindingInterface}
                    className="mt-2 w-full rounded-xl border border-violet-400/25 bg-violet-500/10 px-3 py-2 text-sm font-medium text-violet-100 transition hover:bg-violet-500/20"
                    title={`Select all residues within ${interfaceContactRadius} Å of a different chain`}
                  >
                    Binding interface contacts ({parsed.chains.join('/')})
                  </button>
                )}

                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    data-testid="viewer-select-all"
                    onClick={selectAllResidues}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10"
                  >
                    Select all
                  </button>
                  <button
                    data-testid="viewer-invert-selection"
                    onClick={invertSelection}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10"
                  >
                    Invert selection
                  </button>
                </div>

                {analysisMessage && <p className="text-xs text-cyan-200">{analysisMessage}</p>}
              </div>
            </section>

            {workflowSummary && (
              <section
                ref={workflowSummaryRef}
                data-testid="viewer-workflow-summary"
                className="mt-4 rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-semibold uppercase tracking-wide text-cyan-50">Mutation workspace</h4>
                    <p className="mt-1 text-xs text-cyan-100/80">
                      Keep the active residue set close to the variant workflow without losing structural context.
                    </p>
                  </div>
                  <span className="rounded-full border border-cyan-300/20 bg-slate-950/30 px-2.5 py-1 text-[11px] font-medium text-cyan-50">
                    {workflowSummary.residueCount} selected
                  </span>
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <InspectorStat
                    label="Variant positions"
                    value={workflowSummary.positionsLabel}
                    testId="viewer-workflow-positions"
                  />
                  <InspectorStat
                    label="Chains in play"
                    value={workflowSummary.chains}
                    testId="viewer-workflow-chains"
                  />
                </div>
                <div className="mt-3 rounded-2xl border border-white/10 bg-slate-950/50 px-3 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Latest residue</div>
                  <div data-testid="viewer-workflow-latest" className="mt-2 text-sm font-medium text-slate-100">
                    {workflowSummary.latestResidue}
                  </div>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <button
                    data-testid="viewer-workflow-copy-positions"
                    onClick={copySelectedPositions}
                    className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-slate-50 transition hover:bg-white/15"
                  >
                    Copy positions
                  </button>
                  <button
                    data-testid="viewer-workflow-jump-variants"
                    onClick={scrollToVariantProposal}
                    className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-slate-50 transition hover:bg-white/15"
                  >
                    Jump to variants
                  </button>
                  <button
                    data-testid="viewer-workflow-center"
                    onClick={focusSelection}
                    className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-slate-50 transition hover:bg-white/15"
                  >
                    Center selection
                  </button>
                  {sequence ? (
                    <button
                      data-testid="viewer-workflow-propose"
                      onClick={callProposeVariants}
                      disabled={variantsRunning}
                      className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
                        variantsRunning
                          ? 'bg-slate-700 text-slate-300'
                          : 'bg-violet-500 text-white hover:bg-violet-400'
                      }`}
                    >
                      {variantsRunning ? 'Proposing…' : `Propose ${numVariants} variants`}
                    </button>
                  ) : (
                    <button
                      data-testid="viewer-workflow-copy-residues"
                      onClick={copySelectedResidues}
                      className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-slate-50 transition hover:bg-white/15"
                    >
                      Copy residues
                    </button>
                  )}
                </div>
              </section>
            )}

            <section
              ref={selectedResiduesRef}
              data-testid="viewer-selected-residues"
              className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Chain overview</h4>
                <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-slate-300">
                  {chainSummaries.length} chain{chainSummaries.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="mt-4 space-y-3">
                {chainSummaries.map((summary) => {
                  const active = selectedChain === summary.chain
                  return (
                    <div
                      key={summary.chain}
                      data-testid={`viewer-chain-card-${summary.chain}`}
                      className={`rounded-2xl border p-3 ${
                        active
                          ? 'border-cyan-400/30 bg-cyan-400/10'
                          : 'border-white/10 bg-slate-950/60'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-white">Chain {summary.chain}</div>
                          <div className="mt-1 text-xs text-slate-400">
                            Residues {summary.residueRange} · {summary.residueCount} total
                          </div>
                        </div>
                        <span className="rounded-full bg-white/10 px-2 py-1 text-[11px] font-medium text-slate-200">
                          {summary.selectedCount} selected
                        </span>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <InspectorStat label="Avg B-factor" value={summary.averageBFactor.toFixed(1)} />
                        <InspectorStat label="Residues" value={String(summary.residueCount)} />
                      </div>
                      {/* B-factor profile sparkline */}
                      {(chainBfactorProfiles.get(summary.chain)?.length ?? 0) >= 2 && (
                        <BfactorSparkline
                          points={chainBfactorProfiles.get(summary.chain)!}
                          bfRange={parsed.bFactorRange}
                          selectedNums={new Set(
                            selectedResidues
                              .filter((r) => r.chain === summary.chain)
                              .map((r) => r.residueNum)
                          )}
                          contactNums={new Set(
                            Array.from(contactNetworkKeys)
                              .filter((k) => k.startsWith(`${summary.chain}:`))
                              .map((k) => Number(k.split(':')[1]))
                          )}
                          chainName={summary.chain}
                        />
                      )}
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <button
                          data-testid={`viewer-chain-select-${summary.chain}`}
                          onClick={() => selectChainResidues(summary.chain)}
                          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10"
                        >
                          Select chain residues
                        </button>
                        <button
                          data-testid={`viewer-chain-copy-positions-${summary.chain}`}
                          onClick={() => copyChainPositions(summary.chain)}
                          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10"
                        >
                          Copy chain positions
                        </button>
                      </div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <button
                          data-testid={`viewer-chain-solo-${summary.chain}`}
                          onClick={() => setSelectedChain((prev) => (prev === summary.chain ? 'all' : summary.chain))}
                          className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                            active
                              ? 'bg-cyan-400 text-slate-950'
                              : 'bg-white/5 text-slate-200 hover:bg-white/10'
                          }`}
                        >
                          {active ? 'Show all chains' : `Only chain ${summary.chain}`}
                        </button>
                        <button
                          data-testid={`viewer-chain-hotspots-${summary.chain}`}
                          onClick={() => selectHotspots(3, summary.chain)}
                          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10"
                        >
                          Chain hotspots
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>

            <section
              ref={residueInspectorRef}
              data-testid="viewer-residue-inspector"
              className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Residue inspector</h4>
                <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-slate-300">
                  {selectionSummary ? `${selectionSummary.count} selected` : 'No selection'}
                </span>
              </div>

              {selectionSummary ? (
                <div className="mt-4 space-y-4">
                  <div className="rounded-2xl border border-cyan-400/15 bg-cyan-400/5 p-3">
                    <div className="text-xs font-medium uppercase tracking-wide text-cyan-100">Active residue</div>
                    <div
                      data-testid="viewer-inspector-primary"
                      className="mt-2 text-base font-semibold text-white"
                    >
                      {formatResidueSelection(selectionSummary.primary)}
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <InspectorStat
                        label="Atom count"
                        value={String(selectionSummary.primary.atomCount)}
                        testId="viewer-selected-atom-count"
                      />
                      <InspectorStat
                        label="Avg B-factor"
                        value={selectionSummary.primary.avgBFactor.toFixed(1)}
                        testId="viewer-selected-bfactor"
                      />
                      <InspectorStat
                        label="Sequence residue"
                        value={selectionSummary.primary.sequenceResidue || 'n/a'}
                        testId="viewer-selected-sequence-residue"
                      />
                      <InspectorStat
                        label="Selected range"
                        value={selectionSummary.ranges}
                        testId="viewer-selection-range"
                      />
                    </div>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <InspectorStat
                      label="Selection size"
                      value={`${selectionSummary.count} residue${selectionSummary.count === 1 ? '' : 's'}`}
                    />
                    <InspectorStat
                      label="Max span"
                      value={
                        selectionSummary.count > 1
                          ? `${selectionSummary.maxDistance.toFixed(1)} Å`
                          : 'Select 2+ residues'
                      }
                    />
                    {primaryNeighborCount !== null && (
                      <InspectorStat
                        label={`Neighbors (≤${formatAngstrom(neighborRadiusAngstrom)} Å)`}
                        value={String(primaryNeighborCount)}
                        testId="viewer-inspector-neighbor-count"
                      />
                    )}
                    {selectionSummary.count === 3 && selectionSummary.tripletsAngleDeg !== null && (
                      <InspectorStat
                        label="Cα–Cα–Cα angle"
                        value={`${selectionSummary.tripletsAngleDeg.toFixed(1)}°`}
                        testId="viewer-inspector-angle"
                      />
                    )}
                  </div>

                  <p className="text-xs leading-5 text-slate-400">
                    The inspector follows the latest focused or clicked residue and keeps a compact summary
                    of the current selection for fast structural review.
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-sm text-slate-400">
                  Focus a residue or click markers in the viewer to inspect atom counts, sequence mapping,
                  and selection span.
                </p>
              )}
            </section>

            {selectionAnalytics && (
              <section data-testid="viewer-selection-analytics" className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Selection analytics</h4>
                    <p className="mt-1 text-xs text-slate-400">
                      Review chain spread and the widest measured pair inside the current residue set.
                    </p>
                  </div>
                  <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-slate-300">
                    {selectionAnalytics.labels.length} labels
                  </span>
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <InspectorStat
                    label="Chains involved"
                    value={selectionAnalytics.chains.join(', ')}
                    testId="viewer-selection-chains"
                  />
                  <InspectorStat
                    label="Selection avg B-factor"
                    value={selectionAnalytics.averageBFactor.toFixed(1)}
                    testId="viewer-selection-average-bfactor"
                  />
                </div>
                <div className="mt-3 rounded-2xl border border-white/10 bg-slate-950/70 px-3 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Widest pair</div>
                  {selectionAnalytics.farthestPair ? (
                    <>
                      <div data-testid="viewer-selection-pair" className="mt-2 text-sm font-medium text-slate-100">
                        {selectionAnalytics.farthestPair.left} ↔ {selectionAnalytics.farthestPair.right}
                      </div>
                      <div data-testid="viewer-selection-distance" className="mt-1 text-xs text-slate-400">
                        {selectionAnalytics.farthestPair.distance.toFixed(1)} Å
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <button
                          type="button"
                          data-testid="viewer-selection-use-pair"
                          onClick={selectFarthestPair}
                          className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/15"
                        >
                          Use pair as selection
                        </button>
                        <button
                          type="button"
                          data-testid="viewer-selection-copy-pair"
                          onClick={copyFarthestPair}
                          className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/15"
                        >
                          Copy pair
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="mt-2 text-sm text-slate-400">Select at least two residues to measure a pair distance.</div>
                  )}
                </div>
              </section>
            )}

            {sequenceMapEntries.length > 0 && (
              <section data-testid="viewer-sequence-map" className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Sequence map</h4>
                    <p className="mt-1 text-xs text-slate-400">
                      Click a residue token to focus and seed variant positions directly from sequence order.
                    </p>
                  </div>
                  <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-slate-300">
                    {sequenceMapEntries.length} visible
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-400">
                  <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded bg-slate-500/50" />Hydrophobic</span>
                  <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded bg-teal-500/50" />Polar</span>
                  <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded bg-rose-500/50" />Negative</span>
                  <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded bg-blue-500/50" />Positive</span>
                  <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded bg-green-500/50" />Gly</span>
                  {contactNetworkKeys.size > 0 && (
                    <>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-violet-400" />
                        Contact
                      </span>
                      <button
                        type="button"
                        data-testid="viewer-select-contact-network"
                        onClick={selectContactNetwork}
                        className="rounded-full border border-violet-300/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold text-violet-100 transition hover:bg-violet-500/20"
                      >
                        Select contact network ({contactNetworkKeys.size})
                      </button>
                    </>
                  )}
                </div>
                <div className="mt-4 max-h-56 overflow-y-auto pr-1">
                  <div className="flex flex-wrap gap-2">
                  {sequenceMapEntries.map((entry) => {
                    const label = `${entry.chain}:${entry.residueNum}`
                    const value = entry.sequenceResidue || entry.residue[0] || '?'
                    const isContact = contactNetworkKeys.has(residueKey(entry.chain, entry.residueNum))
                    const toneClass = entry.isSelected
                      ? 'border-cyan-300/50 bg-cyan-400/20 text-cyan-50'
                      : isContact
                        ? 'border-violet-400/40 bg-violet-400/15 text-violet-50'
                        : entry.isHotspot
                          ? 'border-amber-400/30 bg-amber-400/15 text-amber-50'
                          : 'border-white/10 bg-slate-950/70 text-slate-200 hover:bg-white/10'
                    const aaClass = AA_CLASSES[value.toUpperCase()] || 'bg-slate-600/30 text-slate-200'
                    const bfSpread = Math.max(parsed.bFactorRange.max - parsed.bFactorRange.min, 1)
                    const bfNorm = Math.min(1, Math.max(0, (entry.avgBFactor - parsed.bFactorRange.min) / bfSpread))
                    // Color the B-factor bar: blue (low/ordered) → red (high/disordered)
                    const bfHue = Math.round((1 - bfNorm) * 220)

                    return (
                      <button
                        key={label}
                        type="button"
                        data-testid={`viewer-sequence-token-${entry.chain}-${entry.residueNum}`}
                        onClick={(event) =>
                          handleResidueTokenClick(event, {
                            chain: entry.chain,
                            residueNum: entry.residueNum,
                            residue: entry.residue,
                          })
                        }
                        className={`rounded-2xl border px-2.5 py-2 text-left transition ${toneClass}`}
                        title={`${label} ${entry.residue} · B-factor ${entry.avgBFactor.toFixed(1)}${isContact ? ' · within contact radius' : ''} · Shift/Ctrl-click to add/remove`}
                      >
                        <div className="text-[11px] font-semibold uppercase tracking-wide">{label}</div>
                        <div className="mt-1 flex items-center gap-1">
                          <span className={`inline-flex h-5 w-5 items-center justify-center rounded-md text-xs font-bold ${entry.isSelected ? 'bg-white/20 text-white' : aaClass}`}>
                            {value}
                          </span>
                          {isContact && (
                            <span className="inline-block h-1.5 w-1.5 rounded-full bg-violet-400" title="within contact radius" />
                          )}
                        </div>
                        {/* B-factor mini bar */}
                        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/10">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.round(bfNorm * 100)}%`,
                              background: `hsl(${bfHue},80%,55%)`,
                            }}
                          />
                        </div>
                      </button>
                    )
                  })}
                  </div>
                </div>
              </section>
            )}

            <section className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Selected residues</h4>
                <div className="flex flex-wrap items-center gap-2">
                  {selectedResidues.length > 0 && (
                    <>
                      <button
                        type="button"
                        data-testid="viewer-selected-center"
                        onClick={focusSelection}
                        className="rounded-full border border-white/10 bg-white/10 px-2.5 py-1 text-[11px] font-medium text-slate-100 transition hover:bg-white/15"
                      >
                        Center
                      </button>
                      <button
                        type="button"
                        data-testid="viewer-selected-copy-positions"
                        onClick={copySelectedPositions}
                        className="rounded-full border border-white/10 bg-white/10 px-2.5 py-1 text-[11px] font-medium text-slate-100 transition hover:bg-white/15"
                      >
                        Copy positions
                      </button>
                      <button
                        type="button"
                        data-testid="viewer-selected-copy-residues"
                        onClick={copySelectedResidues}
                        className="rounded-full border border-white/10 bg-white/10 px-2.5 py-1 text-[11px] font-medium text-slate-100 transition hover:bg-white/15"
                      >
                        Copy residues
                      </button>
                      {sequence && (
                        <button
                          type="button"
                          data-testid="viewer-selected-copy-fasta"
                          onClick={copySelectedFasta}
                          className="rounded-full border border-emerald-200/20 bg-emerald-300/10 px-2.5 py-1 text-[11px] font-medium text-emerald-50 transition hover:bg-emerald-300/15"
                        >
                          Copy FASTA
                        </button>
                      )}
                    </>
                  )}
                  <button
                    onClick={clearSelection}
                    className="text-xs font-medium text-slate-400 transition hover:text-white"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="mt-3 max-h-40 overflow-y-auto pr-1">
                <div className="flex flex-wrap gap-2">
                {selectedResidues.length > 0 ? (
                  selectedResidues.map((selection) => (
                    <button
                      key={residueKey(selection.chain, selection.residueNum)}
                      onClick={() => {
                        const next = selectedResidues.filter(
                          (item) =>
                            !(item.chain === selection.chain && item.residueNum === selection.residueNum)
                        )
                        setSelectedResidues(next)
                        syncPositionsFromSelection(next)
                      }}
                      className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-xs font-medium text-cyan-100"
                    >
                      {formatResidueSelection(selection)} ×
                    </button>
                  ))
                ) : (
                  <p className="text-sm text-slate-400">Click atoms or residue markers in the viewer to build a selection.</p>
                )}
                </div>
              </div>
            </section>

            {sequence && (
              <section
                ref={variantSectionRef}
                data-testid="viewer-variant-proposal"
                className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4"
              >
                <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Variant proposal</h4>
                <div className="mt-4 space-y-3">
                  <label className="block text-sm text-slate-300">
                    Variant positions
                    <input
                      aria-label="Variant positions"
                      data-testid="variant-positions"
                      value={positionsText}
                      onChange={(event) => setPositionsText(event.target.value)}
                      placeholder="1-based positions e.g. 12,15,16"
                      className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/50"
                    />
                  </label>
                  <label className="block text-sm text-slate-300">
                    Number of variants
                    <input
                      aria-label="Number of variants"
                      data-testid="variant-num"
                      type="number"
                      min={1}
                      max={20}
                      value={numVariants}
                      onChange={(event) => updateNumVariants(Number(event.target.value))}
                      className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/50"
                    />
                  </label>
                  <button
                    onClick={callProposeVariants}
                    data-testid="propose-variants"
                    disabled={variantsRunning}
                    className={`w-full rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
                      variantsRunning
                        ? 'bg-slate-700 text-slate-300'
                        : 'bg-violet-500 text-white hover:bg-violet-400'
                    }`}
                  >
                    {variantsRunning ? 'Proposing…' : 'Propose variants'}
                  </button>
                  <p className="text-xs text-slate-400">
                    Use the selection list above or enter positions manually to seed sequence exploration.
                  </p>
                </div>
              </section>
            )}

            {(variantsError || proposedVariants.length) && (
              <section
                ref={variantResultsRef}
                data-testid="viewer-variant-results"
                className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4"
              >
                <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Proposed variants</h4>
                {variantsError && <p className="mt-3 text-sm text-rose-300">{variantsError}</p>}
                {proposedVariants.length ? (
                  <div className="mt-3 max-h-[26rem] space-y-3 overflow-y-auto pr-1">
                    {proposedVariants.slice(0, 6).map((variant, index) => (
                      <div
                        key={`${variant?.sequence || index}`}
                        className="rounded-2xl border border-white/10 bg-slate-950/70 p-3"
                      >
                        <div className="flex items-center justify-between gap-3 text-sm">
                          <span className="font-medium text-slate-200">Score</span>
                          <span data-testid={`variant-score-${index}`} className="text-cyan-200">
                            {String(variant?.score ?? '')}
                          </span>
                        </div>
                        <div
                          data-testid={`variant-sequence-${index}`}
                          className="mt-2 break-all font-mono text-xs text-slate-200"
                        >
                          {String(variant?.sequence ?? '')}
                        </div>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          {typeof variant?.sequence === 'string' && onUseSequence && (
                            <button
                              data-testid={`iterate-variant-${index}`}
                              onClick={() => iterateWithVariant(variant)}
                              className="rounded-xl bg-cyan-400 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300"
                            >
                              Iterate with this
                            </button>
                          )}
                          {typeof variant?.sequence === 'string' && (
                            <button
                              data-testid={`save-variant-${index}`}
                              onClick={() => saveVariantToLibrary(variant)}
                              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10"
                            >
                              Save to Library
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            )}

            <section className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
              <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-300">AA composition</h4>
              <p className="mt-1 text-xs text-slate-400">Physicochemical class breakdown of {visibleResidues.length} visible residues.</p>
              <AaCompositionChart residues={visibleResidues} />
            </section>

            <section className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
              <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Legend</h4>
              <div className="mt-3 space-y-2 text-sm text-slate-300">
                {showHydrophobicity && !showHeatmap ? (
                  <>
                    <div className="flex items-center justify-between gap-3 text-xs text-slate-400">
                      <span>Hydrophilic</span>
                      <div
                        className="h-3 flex-1 rounded-full"
                        style={{ background: 'linear-gradient(to right, #3b82f6, #f5f5f5, #fb923c)' }}
                      />
                      <span>Hydrophobic</span>
                    </div>
                    <p className="pt-1 text-xs text-slate-500">
                      Eisenberg scale: blue = hydrophilic, orange = hydrophobic. Press Y to toggle.
                    </p>
                  </>
                ) : colorByAAClass && !showHeatmap ? (
                  <>
                    {[
                      { label: 'Hydrophobic', color: '#94a3b8' },
                      { label: 'Polar', color: '#2dd4bf' },
                      { label: 'Negative (Asp/Glu)', color: '#fb7185' },
                      { label: 'Positive (Lys/Arg/His)', color: '#60a5fa' },
                      { label: 'Gly / Pro', color: '#86efac' },
                    ].map(({ label, color }) => (
                      <LegendItem key={label} label={label} color={new THREE.Color(color)} />
                    ))}
                    <p className="pt-1 text-xs text-slate-500">
                      Physicochemical class coloring on Cα spheres. Press A to toggle.
                    </p>
                  </>
                ) : colorByChain && !showHeatmap && (renderMode === 'ribbon' || renderMode === 'cartoon') ? (
                  <>
                    {parsed.chains.map((chain, i) => (
                      <LegendItem
                        key={chain}
                        testId={`viewer-legend-chain-${chain}`}
                        label={`Chain ${chain}`}
                        color={new THREE.Color(CHAIN_PALETTE[i % CHAIN_PALETTE.length])}
                        active={selectedChain === chain}
                        onClick={() => toggleLegendChain(chain)}
                        detail={selectedChain === chain ? 'Showing only this chain' : 'Click to isolate'}
                      />
                    ))}
                    <p className="pt-1 text-xs text-slate-500">
                      Click a chain legend entry to isolate it in the viewer; click again to restore all chains.
                    </p>
                  </>
                ) : renderMode === 'ribbon' || renderMode === 'cartoon' ? (
                  <>
                    {Object.entries(SECONDARY_COLORS).map(([label, color]) => (
                      <LegendItem key={label} label={label} color={new THREE.Color(color)} />
                    ))}
                  </>
                ) : (
                  <>
                    {Object.entries(ELEMENT_COLORS)
                      .filter(([key]) => key !== 'default')
                      .map(([label, color]) => (
                        <LegendItem key={label} label={label} color={new THREE.Color(color)} />
                      ))}
                  </>
                )}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  )

  const portalRoot = globalThis?.document?.body
  return portalRoot ? createPortal(viewerContent, portalRoot) : viewerContent
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-2 text-xl font-semibold text-white">{value}</div>
    </div>
  )
}

function LegendItem({
  label,
  color,
  active = false,
  detail,
  onClick,
  testId,
}: {
  label: string
  color: THREE.Color
  active?: boolean
  detail?: string
  onClick?: () => void
  testId?: string
}) {
  const content = (
    <>
      <span className="h-3 w-3 rounded-full" style={{ backgroundColor: `#${color.getHexString()}` }} />
      <span className="min-w-0 flex-1 truncate capitalize text-left text-slate-300">{label}</span>
      {detail ? (
        <span className={`text-[11px] ${active ? 'text-cyan-200' : 'text-slate-500'}`}>{detail}</span>
      ) : null}
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        data-testid={testId}
        aria-pressed={active}
        onClick={onClick}
        className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition ${
          active
            ? 'border-cyan-400/30 bg-cyan-400/10'
            : 'border-white/10 bg-slate-950/40 hover:bg-white/5'
        }`}
      >
        {content}
      </button>
    )
  }

  return <div className="flex items-center gap-2">{content}</div>
}

function InspectorStat({
  label,
  value,
  testId,
}: {
  label: string
  value: string
  testId?: string
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/70 px-3 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div data-testid={testId} className="mt-2 text-sm font-medium text-slate-100">
        {value}
      </div>
    </div>
  )
}

const THREE_TO_ONE_AA: Record<string, string> = { ALA:'A',ARG:'R',ASN:'N',ASP:'D',CYS:'C',GLN:'Q',GLU:'E',GLY:'G',HIS:'H',ILE:'I',LEU:'L',LYS:'K',MET:'M',PHE:'F',PRO:'P',SER:'S',THR:'T',TRP:'W',TYR:'Y',VAL:'V' }
const AA_PHYS_CLASS: Record<string, 'hydrophobic' | 'polar' | 'negative' | 'positive' | 'special'> = {
  A: 'hydrophobic', V: 'hydrophobic', L: 'hydrophobic', I: 'hydrophobic', M: 'hydrophobic',
  F: 'hydrophobic', W: 'hydrophobic', P: 'hydrophobic',
  S: 'polar', T: 'polar', C: 'polar', Y: 'polar', N: 'polar', Q: 'polar',
  D: 'negative', E: 'negative',
  K: 'positive', R: 'positive', H: 'positive',
  G: 'special',
}
const AA_CLASS_CONFIG = [
  { key: 'hydrophobic', label: 'Hydrophobic', color: '#94a3b8', bg: 'bg-slate-400/70' },
  { key: 'polar', label: 'Polar', color: '#2dd4bf', bg: 'bg-teal-400/70' },
  { key: 'negative', label: 'Negative', color: '#fb7185', bg: 'bg-rose-400/70' },
  { key: 'positive', label: 'Positive', color: '#60a5fa', bg: 'bg-blue-400/70' },
  { key: 'special', label: 'Gly/Pro', color: '#86efac', bg: 'bg-green-400/70' },
] as const

function AaCompositionChart({ residues }: { residues: ResidueSummary[] }) {
  if (residues.length === 0) return <p className="mt-2 text-xs text-slate-500">No residues to analyse.</p>
  const counts: Record<string, number> = { hydrophobic: 0, polar: 0, negative: 0, positive: 0, special: 0, unknown: 0 }
  for (const r of residues) {
    const one = r.residue.length === 3 ? (THREE_TO_ONE_AA[r.residue] ?? '') : r.residue[0] ?? ''
    const cls = AA_PHYS_CLASS[one.toUpperCase()] ?? 'unknown'
    counts[cls] += 1
  }
  const total = residues.length
  return (
    <div className="mt-3 space-y-2.5" data-testid="viewer-aa-composition">
      {/* Stacked proportion bar */}
      <div className="flex h-3 w-full overflow-hidden rounded-full" data-testid="viewer-aa-comp-bar">
        {AA_CLASS_CONFIG.map(({ key, color }) => {
          const pct = (counts[key] / total) * 100
          if (pct < 0.5) return null
          return (
            <div
              key={key}
              style={{ width: `${pct}%`, backgroundColor: color + 'cc' }}
              title={`${key}: ${Math.round(pct)}%`}
            />
          )
        })}
      </div>
      {/* Per-class breakdown */}
      <div className="space-y-1">
        {AA_CLASS_CONFIG.map(({ key, label, color }) => {
          const count = counts[key]
          const pct = Math.round((count / total) * 100)
          if (count === 0) return null
          return (
            <div key={key} className="flex items-center gap-2 text-[11px]">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
              <span className="flex-1 text-slate-400">{label}</span>
              <span className="font-semibold tabular-nums text-slate-200">{pct}%</span>
              <span className="tabular-nums text-slate-500">({count})</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// SVG sparkline chart for B-factor profile of a chain
function BfactorSparkline({
  points,
  bfRange,
  selectedNums,
  contactNums,
  chainName,
}: {
  points: { residueNum: number; bf: number }[]
  bfRange: { min: number; max: number; average: number }
  selectedNums: Set<number>
  contactNums: Set<number>
  chainName: string
}) {
  if (points.length < 2) return null
  const W = 240
  const H = 40
  const spread = Math.max(bfRange.max - bfRange.min, 1)
  const xs = points.map((_, i) => Math.round((i / (points.length - 1)) * W))
  const ys = points.map((p) => Math.round(H - ((p.bf - bfRange.min) / spread) * H))
  const pathD = points.map((_, i) => `${i === 0 ? 'M' : 'L'}${xs[i]},${ys[i]}`).join(' ')
  return (
    <div data-testid={`viewer-bfactor-sparkline-${chainName}`} className="mt-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">B-factor profile</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 w-full" style={{ height: H }}>
        {/* Average line */}
        <line
          x1={0}
          y1={Math.round(H - ((bfRange.average - bfRange.min) / spread) * H)}
          x2={W}
          y2={Math.round(H - ((bfRange.average - bfRange.min) / spread) * H)}
          stroke="#475569"
          strokeWidth="0.75"
          strokeDasharray="3 2"
        />
        {/* Profile line */}
        <path d={pathD} fill="none" stroke="#22d3ee" strokeWidth="1.5" strokeLinejoin="round" opacity="0.75" />
        {/* Contact residue dots */}
        {points.map((p, i) =>
          contactNums.has(p.residueNum) ? (
            <circle key={p.residueNum} cx={xs[i]} cy={ys[i]} r="2.5" fill="#f59e0b" fillOpacity="0.85" />
          ) : selectedNums.has(p.residueNum) ? (
            <circle key={p.residueNum} cx={xs[i]} cy={ys[i]} r="3" fill="#22d3ee" />
          ) : null
        )}
      </svg>
      <div className="flex justify-between text-[9px] text-slate-600">
        <span>{bfRange.min.toFixed(0)}</span>
        <span>avg {bfRange.average.toFixed(0)}</span>
        <span>{bfRange.max.toFixed(0)}</span>
      </div>
    </div>
  )
}
