export const AGENT_CHARACTERS = [
  'layer-blue-pyramid-character',
  'layer-dark-bat-character',
  'layer-green-cactus-character',
  'layer-orange-sun-character',
  'layer-pink-cloud-character',
  'layer-purple-donut-character',
  'layer-purple-slime-character',
  'layer-teal-blob-character',
  'layer-yellow-star-character',
];

export const AGENT_AVATAR_COLORS = [
  '#f4f4f5',
  '#a1a1aa',
  '#27272a',
  '#450a0a',
  '#7f1d1d',
  '#7c2d12',
  '#713f12',
  '#eab308',
  '#14532d',
  '#166534',
  '#134e4a',
  '#0e7490',
  '#1e3a5f',
  '#1d4ed8',
  '#3b0764',
  '#86198f',
];

export const AGENT_AVATAR_DEFAULT_COLOR = '#27272a';

export interface AgentAvatar {
  character: string;
  color: string;
}
