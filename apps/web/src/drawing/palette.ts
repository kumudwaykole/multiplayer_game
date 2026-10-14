/** The classic two-row party-game palette, with names for screen readers. */
export const PALETTE: ReadonlyArray<{ hex: string; name: string }> = [
  { hex: '#ffffff', name: 'White' },
  { hex: '#c1c1c1', name: 'Light grey' },
  { hex: '#ef130b', name: 'Red' },
  { hex: '#ff7100', name: 'Orange' },
  { hex: '#ffe400', name: 'Yellow' },
  { hex: '#00cc00', name: 'Green' },
  { hex: '#00ff91', name: 'Mint' },
  { hex: '#00b2ff', name: 'Sky blue' },
  { hex: '#231fd3', name: 'Blue' },
  { hex: '#a300ba', name: 'Purple' },
  { hex: '#df69a7', name: 'Pink' },
  { hex: '#ffac8e', name: 'Peach' },
  { hex: '#a0522d', name: 'Brown' },
  { hex: '#000000', name: 'Black' },
  { hex: '#505050', name: 'Dark grey' },
  { hex: '#740b07', name: 'Dark red' },
  { hex: '#c23800', name: 'Burnt orange' },
  { hex: '#e8a200', name: 'Gold' },
  { hex: '#005510', name: 'Dark green' },
  { hex: '#00785d', name: 'Teal' },
  { hex: '#00569e', name: 'Navy' },
  { hex: '#0e0865', name: 'Midnight' },
  { hex: '#550069', name: 'Plum' },
  { hex: '#873554', name: 'Berry' },
  { hex: '#cc774d', name: 'Tan' },
  { hex: '#63300d', name: 'Chocolate' },
]

/** Brush diameters in logical pixels (the server allows 1-40). */
export const BRUSH_SIZES = [4, 10, 18, 28, 40] as const

export type Tool = 'pen' | 'eraser' | 'fill'
