'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { addToDesignLibrary } from '@/lib/design-library'

type RenderMode = 'ribbon' | 'cartoon' | 'sphere' | 'stick'
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
    const helixDistance = distance(current, lookahead)
    const strandDistance = distance(prev, next)

    if (helixDistance >= 4.8 && helixDistance <= 6.4 && angle >= 65 && angle <= 130) {
      labels[index] = 'helix'
      labels[index + 1] = 'helix'
      continue
    }

    if (strandDistance >= 6.1 && strandDistance <= 7.5 && angle >= 135) {
      labels[index] = 'sheet'
      continue
    }

    if (angle >= 110 && angle < 135) {
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

function buildMolecule(
  model: ParseResult,
  mode: RenderMode,
  heatmap: boolean,
  colorByChain: boolean,
  selectedChain: string,
  selectedResidues: ResidueSelection[]
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
      const chainColor = (colorByChain && !heatmap) ? chainPaletteColor(chain, model.chains) : undefined
      createRibbonRepresentation(group, residues, model, heatmap, selectedKeys, chainColor)
    })
  } else if (mode === 'cartoon') {
    chainGroups.forEach((residues, chain) => {
      const chainColor = (colorByChain && !heatmap) ? chainPaletteColor(chain, model.chains) : undefined
      createCartoonRepresentation(group, residues, model, heatmap, selectedKeys, chainColor)
    })
  } else if (mode === 'sphere') {
    createAtomicRepresentation(group, visibleAtoms, visibleResidues, selectedKeys, false)
  } else {
    createAtomicRepresentation(group, visibleAtoms, visibleResidues, selectedKeys, true)
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

  const [error, setError] = useState<string | null>(null)
  const [renderMode, setRenderMode] = useState<RenderMode>('ribbon')
  const [showHeatmap, setShowHeatmap] = useState(false)
  const [colorByChain, setColorByChain] = useState(true)
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
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; label: string; bFactor: string } | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [labelOverlays, setLabelOverlays] = useState<Array<{ key: string; x: number; y: number; label: string; color: string }>>([])
  const labelOverlaysRef = useRef<Array<{ key: string; x: number; y: number; label: string; color: string }>>([])
  const [showLabels, setShowLabels] = useState(true)

  const parsed = useMemo(() => parsePDB(pdbData), [pdbData])

  const selectedResidueDetails = useMemo(
    () =>
      selectedResidues
        .map((selection) => {
          const residue = parsed.residues.find(
            (item) => item.chain === selection.chain && item.residueNum === selection.residueNum
          )
          if (!residue) return null

          return {
            ...selection,
            atomCount: residue.atoms.length,
            avgBFactor: residue.avgBFactor,
            sequenceResidue:
              sequence && selection.residueNum >= 1 && selection.residueNum <= sequence.length
                ? sequence[selection.residueNum - 1]
                : undefined,
            center: residue.caAtom ? getAtomPosition(residue.caAtom) : residue.center.clone(),
          }
        })
        .filter(Boolean) as Array<
        ResidueSelection & {
          atomCount: number
          avgBFactor: number
          sequenceResidue?: string
          center: THREE.Vector3
        }
      >,
    [parsed.residues, selectedResidues, sequence]
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

    return {
      count: selectedResidueDetails.length,
      primary: selectedResidueDetails[selectedResidueDetails.length - 1],
      ranges: formatResidueRanges(positions),
      averageBFactor:
        selectedResidueDetails.reduce((sum, item) => sum + item.avgBFactor, 0) /
        selectedResidueDetails.length,
      maxDistance,
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

  // Expose selectedResidues to the animation loop without causing re-render
  useEffect(() => {
    ;(window as any).__pv3d_selected = selectedResidues
    return () => { delete (window as any).__pv3d_selected }
  }, [selectedResidues])

  useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.autoRotate = autoRotate
    }
  }, [autoRotate])

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
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

  const focusOnResidue = () => {
    const query = focusResidue.trim()
    if (!query) {
      setAnalysisMessage('Enter a residue number or chain:number to focus the camera.')
      return
    }

    let chain = selectedChain !== 'all' ? selectedChain : ''
    let residueNum: number | null = null

    if (query.includes(':')) {
      const [queryChain, residueToken] = query.split(':')
      chain = queryChain.trim() || chain
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
        selectedResidues
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

        setSelectedResidues((prev) => {
          const exists = prev.some(
            (item) => item.chain === selection.chain && item.residueNum === selection.residueNum
          )
          const next = exists
            ? prev.filter(
                (item) => !(item.chain === selection.chain && item.residueNum === selection.residueNum)
              )
            : [...prev, selection]
          syncPositionsFromSelection(next)
          return next
        })
      }
      renderer.domElement.addEventListener('click', handleClick)

      const handleMouseMove = (event: MouseEvent) => {
        if (!cameraRef.current || !sceneRef.current || !rendererRef.current) return
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
          setHoverInfo({
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
            label: `${data.chain}:${data.residueNum} ${data.residue}${atomName}`,
            bFactor: '',
          })
        } else {
          setHoverInfo(null)
        }
      }
      renderer.domElement.addEventListener('mousemove', handleMouseMove)
      renderer.domElement.addEventListener('mouseleave', () => setHoverInfo(null))

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
        if (rect.width > 0 && rect.height > 0 && labelOverlaysRef.current !== undefined) {
          // We'll update labels via a throttled mechanism - skip if no selection
          const selectedKeys = new Set(
            (window as any).__pv3d_selected?.map((r: ResidueSelection) =>
              `${r.chain || '_'}:${r.residueNum}`
            ) || []
          )
          if (selectedKeys.size > 0) {
            const overlays: typeof labelOverlaysRef.current = []
            selectedKeys.forEach((keyValue) => {
              const key = keyValue as string
              const worldPos = residueCenters.get(key)
              if (!worldPos) return
              const proj = worldPos.clone().project(camera)
              const x = ((proj.x + 1) / 2) * rect.width
              const y = (-(proj.y - 1) / 2) * rect.height
              if (proj.z < 1) {
                const parts = key.split(':')
                const chain = parts[0] === '_' ? '' : parts[0]
                const num = parts[1]
                overlays.push({
                  key,
                  x,
                  y,
                  label: chain ? `${chain}:${num}` : num,
                  color: chain ? `#${chainPaletteColor(chain, parsed.chains).getHexString()}` : '#60a5fa',
                })
              }
            })
            // Only update state if values changed (compare JSON to avoid excessive re-renders)
            const next = JSON.stringify(overlays)
            const prev = JSON.stringify(labelOverlaysRef.current)
            if (next !== prev) {
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
  }, [onClose, parsed, renderMode, colorByChain, selectedChain, selectedResidues, showHeatmap])

  const clearSelection = () => {
    applySelection([], 'Cleared the current residue selection.')
  }

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
              className="flex items-center gap-2 overflow-x-auto border-b border-white/10 px-4 py-3 pb-4"
            >
              {([
                ['ribbon', 'Ribbon'],
                ['cartoon', 'Cartoon'],
                ['sphere', 'Ball & Stick'],
                ['stick', 'Stick'],
              ] as Array<[RenderMode, string]>).map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => setRenderMode(mode)}
                  className={`shrink-0 rounded-full px-3 py-2 text-sm font-medium transition ${
                    renderMode === mode
                      ? 'bg-cyan-400 text-slate-950'
                      : 'bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  {label}
                </button>
              ))}

              <button
                onClick={() => setShowHeatmap((prev) => !prev)}
                className={`shrink-0 rounded-full px-3 py-2 text-sm font-medium transition ${
                  showHeatmap
                    ? 'bg-amber-400 text-slate-950'
                    : 'bg-white/5 text-slate-300 hover:bg-white/10'
                }`}
                title="B-factor heatmap"
              >
                B-factor heatmap
              </button>

              <button
                data-testid="viewer-color-by-chain"
                onClick={() => setColorByChain((prev) => !prev)}
                className={`shrink-0 rounded-full px-3 py-2 text-sm font-medium transition ${
                  colorByChain
                    ? 'bg-emerald-500 text-white'
                    : 'bg-white/5 text-slate-300 hover:bg-white/10'
                }`}
                title="Toggle chain-based coloring"
              >
                Chain colors
              </button>

              <button
                onClick={resetView}
                className="shrink-0 rounded-full bg-white/5 px-3 py-2 text-sm font-medium text-slate-300 transition hover:bg-white/10"
              >
                Reset view
              </button>

              <button
                data-testid="viewer-focus-selection"
                onClick={focusSelection}
                className="shrink-0 rounded-full bg-white/5 px-3 py-2 text-sm font-medium text-slate-300 transition hover:bg-white/10"
              >
                Center selection
              </button>

              <button
                data-testid="viewer-auto-rotate"
                onClick={() => setAutoRotate((prev) => !prev)}
                className={`shrink-0 rounded-full px-3 py-2 text-sm font-medium transition ${
                  autoRotate
                    ? 'bg-emerald-400 text-slate-950'
                    : 'bg-white/5 text-slate-300 hover:bg-white/10'
                }`}
              >
                {autoRotate ? 'Auto-rotate on' : 'Auto-rotate off'}
              </button>

              <button
                data-testid="viewer-snapshot"
                onClick={downloadSnapshot}
                className="shrink-0 rounded-full bg-white/5 px-3 py-2 text-sm font-medium text-slate-300 transition hover:bg-white/10"
              >
                Save PNG
              </button>

              <button
                data-testid="viewer-download-pdb"
                onClick={downloadPDB}
                className="shrink-0 rounded-full bg-white/5 px-3 py-2 text-sm font-medium text-slate-300 transition hover:bg-white/10"
              >
                Download PDB
              </button>

              <button
                data-testid="viewer-show-labels"
                onClick={() => setShowLabels((prev) => !prev)}
                className={`shrink-0 rounded-full px-3 py-2 text-sm font-medium transition ${
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
                {isFullscreen ? '⊡ Restore' : '⊠ Expand'}
              </button>

              <div className="ml-auto hidden shrink-0 text-xs text-slate-400 xl:block">
                Rotate: drag · Zoom: scroll · Select: click · Hover: inspect residue
              </div>
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
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    Secondary structure
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-slate-400">
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
                </div>
                <div className="mt-2 flex h-3 w-full overflow-hidden rounded-full">
                  {secondaryStructureComposition.helix > 0 && (
                    <div
                      data-testid="viewer-ss-helix-bar"
                      className="bg-rose-400"
                      style={{ width: `${secondaryStructureComposition.helix}%` }}
                      title={`Helix ${secondaryStructureComposition.helix}%`}
                    />
                  )}
                  {secondaryStructureComposition.sheet > 0 && (
                    <div
                      data-testid="viewer-ss-sheet-bar"
                      className="bg-yellow-400"
                      style={{ width: `${secondaryStructureComposition.sheet}%` }}
                      title={`Sheet ${secondaryStructureComposition.sheet}%`}
                    />
                  )}
                  {secondaryStructureComposition.turn > 0 && (
                    <div
                      data-testid="viewer-ss-turn-bar"
                      className="bg-cyan-400"
                      style={{ width: `${secondaryStructureComposition.turn}%` }}
                      title={`Turn ${secondaryStructureComposition.turn}%`}
                    />
                  )}
                  {secondaryStructureComposition.coil > 0 && (
                    <div
                      data-testid="viewer-ss-coil-bar"
                      className="flex-1 bg-slate-600"
                      title={`Coil ${secondaryStructureComposition.coil}%`}
                    />
                  )}
                </div>
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
                        onClick={() => {
                          const positions = new Set(selectedResidues.map((r) => r.residueNum))
                          const fasta = Array.from(positions)
                            .sort((a, b) => a - b)
                            .filter((pos) => pos >= 1 && pos <= sequence.length)
                            .map((pos) => sequence[pos - 1])
                            .join('')
                          if (!fasta) return
                          const header = `>Selection_${fasta.length}aa`
                          copyTextToClipboard(`${header}\n${fasta}`)
                        }}
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
                  Focus residue
                  <div className="mt-2 flex gap-2">
                    <input
                      data-testid="viewer-focus-residue"
                      value={focusResidue}
                      onChange={(event) => setFocusResidue(event.target.value)}
                      placeholder="e.g. 42 or A:42"
                      className="min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/50"
                    />
                    <button
                      data-testid="viewer-focus-button"
                      onClick={focusOnResidue}
                      className="rounded-xl bg-cyan-400 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300"
                    >
                      Focus
                    </button>
                  </div>
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
                </div>
                <div className="mt-4 max-h-56 overflow-y-auto pr-1">
                  <div className="flex flex-wrap gap-2">
                  {sequenceMapEntries.map((entry) => {
                    const label = `${entry.chain}:${entry.residueNum}`
                    const value = entry.sequenceResidue || entry.residue[0] || '?'
                    const toneClass = entry.isSelected
                      ? 'border-cyan-300/50 bg-cyan-400/20 text-cyan-50'
                      : entry.isHotspot
                        ? 'border-amber-400/30 bg-amber-400/15 text-amber-50'
                        : 'border-white/10 bg-slate-950/70 text-slate-200 hover:bg-white/10'
                    const aaClass = AA_CLASSES[value.toUpperCase()] || 'bg-slate-600/30 text-slate-200'

                    return (
                      <button
                        key={label}
                        type="button"
                        data-testid={`viewer-sequence-token-${entry.chain}-${entry.residueNum}`}
                        onClick={() =>
                          selectSingleResidue({
                            chain: entry.chain,
                            residueNum: entry.residueNum,
                            residue: entry.residue,
                          })
                        }
                        className={`rounded-2xl border px-2.5 py-2 text-left transition ${toneClass}`}
                        title={`${label} ${entry.residue} · B-factor ${entry.avgBFactor.toFixed(1)}`}
                      >
                        <div className="text-[11px] font-semibold uppercase tracking-wide">{label}</div>
                        <div className="mt-1 flex items-center gap-1">
                          <span className={`inline-flex h-5 w-5 items-center justify-center rounded-md text-xs font-bold ${entry.isSelected ? 'bg-white/20 text-white' : aaClass}`}>
                            {value}
                          </span>
                        </div>
                      </button>
                    )
                  })}
                  </div>
                </div>
              </section>
            )}

            <section className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Selected residues</h4>
                <button
                  onClick={clearSelection}
                  className="text-xs font-medium text-slate-400 transition hover:text-white"
                >
                  Clear
                </button>
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
              <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Legend</h4>
              <div className="mt-3 space-y-2 text-sm text-slate-300">
                {colorByChain && !showHeatmap && (renderMode === 'ribbon' || renderMode === 'cartoon') ? (
                  <>
                    {parsed.chains.map((chain, i) => (
                      <LegendItem
                        key={chain}
                        label={`Chain ${chain}`}
                        color={new THREE.Color(CHAIN_PALETTE[i % CHAIN_PALETTE.length])}
                      />
                    ))}
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

function LegendItem({ label, color }: { label: string; color: THREE.Color }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-3 w-3 rounded-full" style={{ backgroundColor: `#${color.getHexString()}` }} />
      <span className="capitalize text-slate-300">{label}</span>
    </div>
  )
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
