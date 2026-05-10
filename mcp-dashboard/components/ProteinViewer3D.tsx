'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
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

type BuildResult = {
  group: THREE.Group
  residueCenters: Map<string, THREE.Vector3>
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

const DEFAULT_NUM_VARIANTS = 5

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
  selectedKeys: Set<string>
) {
  const caResidues = residues.filter((residue) => residue.caAtom)
  if (caResidues.length < 2) return

  const points = caResidues.map((residue) => getAtomPosition(residue.caAtom!))
  const curve = new THREE.CatmullRomCurve3(points)
  const color = heatmap
    ? getBFactorColor(model.bFactorRange.average, model.bFactorRange)
    : new THREE.Color(0x93c5fd)
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
          : getStructureColor('coil', heatmap, residue.avgBFactor, model),
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
  selectedKeys: Set<string>
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
    const color = getStructureColor(segment.type, heatmap, averageB, model)

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
    chainGroups.forEach((residues) => createRibbonRepresentation(group, residues, model, heatmap, selectedKeys))
  } else if (mode === 'cartoon') {
    chainGroups.forEach((residues) => createCartoonRepresentation(group, residues, model, heatmap, selectedKeys))
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

  const [error, setError] = useState<string | null>(null)
  const [renderMode, setRenderMode] = useState<RenderMode>('ribbon')
  const [showHeatmap, setShowHeatmap] = useState(false)
  const [selectedResidues, setSelectedResidues] = useState<ResidueSelection[]>([])
  const [positionsText, setPositionsText] = useState('')
  const [numVariants, setNumVariants] = useState(DEFAULT_NUM_VARIANTS)
  const [variantsResult, setVariantsResult] = useState<any>(null)
  const [variantsError, setVariantsError] = useState<string | null>(null)
  const [variantsRunning, setVariantsRunning] = useState(false)
  const [selectedChain, setSelectedChain] = useState('all')
  const [focusResidue, setFocusResidue] = useState('')
  const [analysisMessage, setAnalysisMessage] = useState<string | null>(null)

  const parsed = useMemo(() => parsePDB(pdbData), [pdbData])

  const visibleResidues = useMemo(
    () =>
      parsed.residues.filter((residue) => selectedChain === 'all' || residue.chain === selectedChain),
    [parsed.residues, selectedChain]
  )

  useEffect(() => {
    setSelectedResidues((prev) =>
      prev.filter((residue) => selectedChain === 'all' || residue.chain === selectedChain)
    )
  }, [selectedChain])

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

  const syncPositionsFromSelection = (selection: ResidueSelection[]) => {
    const positions = Array.from(new Set(selection.map((residue) => residue.residueNum))).sort((a, b) => a - b)
    setPositionsText(positions.join(','))
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
    const safeTangent = Number.isFinite(tangent) && tangent > 0.001 ? tangent : 0.577
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

    const controls = controlsRef.current
    const camera = cameraRef.current
    if (!controls || !camera) return

    const offset = new THREE.Vector3(4, 4, 10)
    controls.target.copy(center)
    camera.position.copy(center.clone().add(offset))
    controls.update()

    setSelectedResidues((prev) => {
      if (prev.some((residue) => residue.chain === chain && residue.residueNum === residueNum)) {
        return prev
      }
      const residue = visibleResidues.find(
        (item) => item.chain === chain && item.residueNum === resolvedResidueNum
      )
      const next = [
        ...prev,
        { chain, residueNum: resolvedResidueNum, residue: residue?.residue || 'UNK' },
      ]
      syncPositionsFromSelection(next)
      return next
    })

    setAnalysisMessage(`Focused on residue ${chain}:${resolvedResidueNum}.`)
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
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.setSize(width, height)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      container.appendChild(renderer.domElement)
      rendererRef.current = renderer

      const controls = new OrbitControls(camera, renderer.domElement)
      controls.enableDamping = true
      controls.dampingFactor = 0.06
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
      }
      animate()

      return () => {
        window.removeEventListener('resize', handleResize)
        renderer.domElement.removeEventListener('click', handleClick)
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
  }, [onClose, parsed, renderMode, selectedChain, selectedResidues, showHeatmap])

  const clearSelection = () => {
    setSelectedResidues([])
    setPositionsText('')
  }

  const residueStats = {
    atoms: parsed.atoms.length,
    residues: parsed.residues.length,
    visibleResidues: visibleResidues.length,
    chains: parsed.chains.length,
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm">
      <div className="flex h-[92vh] w-full max-w-7xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-slate-900 shadow-2xl shadow-slate-950/40">
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

        <div className="grid flex-1 overflow-hidden xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-h-0 flex-col border-b border-white/10 xl:border-b-0 xl:border-r">
            <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3">
              {([
                ['ribbon', 'Ribbon'],
                ['cartoon', 'Cartoon'],
                ['sphere', 'Ball & Stick'],
                ['stick', 'Stick'],
              ] as Array<[RenderMode, string]>).map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => setRenderMode(mode)}
                  className={`rounded-full px-3 py-2 text-sm font-medium transition ${
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
                className={`rounded-full px-3 py-2 text-sm font-medium transition ${
                  showHeatmap
                    ? 'bg-amber-400 text-slate-950'
                    : 'bg-white/5 text-slate-300 hover:bg-white/10'
                }`}
                title="B-factor heatmap"
              >
                B-factor heatmap
              </button>

              <button
                onClick={resetView}
                className="rounded-full bg-white/5 px-3 py-2 text-sm font-medium text-slate-300 transition hover:bg-white/10"
              >
                Reset view
              </button>

              <div className="ml-auto text-xs text-slate-400">Rotate: drag · Zoom: scroll · Select: click residues</div>
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

            <div className="flex-1 bg-slate-950/60">
              {error ? (
                <div className="flex h-full items-center justify-center px-6 text-center">
                  <div>
                    <div className="mb-3 text-5xl">⚠️</div>
                    <p className="text-lg font-medium text-rose-300">{error}</p>
                  </div>
                </div>
              ) : (
                <div ref={containerRef} className="h-full w-full" />
              )}
            </div>
          </div>

          <aside className="flex min-h-0 flex-col overflow-y-auto bg-slate-900/95 p-4">
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

                {analysisMessage && <p className="text-xs text-cyan-200">{analysisMessage}</p>}
              </div>
            </section>

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
              <div className="mt-3 flex flex-wrap gap-2">
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
            </section>

            {sequence && (
              <section className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
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
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        setNumVariants(
                          Number.isFinite(value) && value >= 1
                            ? Math.min(20, Math.floor(value))
                            : DEFAULT_NUM_VARIANTS
                        )
                      }}
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

            {(variantsError || variantsResult?.variants?.length) && (
              <section className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
                <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Proposed variants</h4>
                {variantsError && <p className="mt-3 text-sm text-rose-300">{variantsError}</p>}
                {variantsResult?.variants?.length ? (
                  <div className="mt-3 space-y-3">
                    {variantsResult.variants.slice(0, 6).map((variant: any, index: number) => (
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
                              onClick={() => {
                                onUseSequence(variant.sequence)
                                onClose()
                              }}
                              className="rounded-xl bg-cyan-400 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300"
                            >
                              Iterate with this
                            </button>
                          )}
                          {typeof variant?.sequence === 'string' && (
                            <button
                              data-testid={`save-variant-${index}`}
                              onClick={() => {
                                addToDesignLibrary({
                                  sequence: variant.sequence,
                                  score: typeof variant?.score === 'number' ? variant.score : undefined,
                                  positions: Array.isArray(variant?.positions) ? variant.positions : undefined,
                                  source: title || '3D Viewer Variant',
                                  pdbData,
                                })
                              }}
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
                {renderMode === 'ribbon' || renderMode === 'cartoon' ? (
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
