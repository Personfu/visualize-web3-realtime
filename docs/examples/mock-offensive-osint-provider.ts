export type IntelNodeKind = 'domain' | 'certificate' | 'asn' | 'service' | 'cve' | 'repo';

export interface IntelNode {
  id: string;
  label: string;
  kind: IntelNodeKind;
  tier: 'free' | 'basic' | 'premium';
  risk: number;
}

export interface IntelEdge {
  source: string;
  target: string;
  relationship: 'resolves-to' | 'issued-for' | 'announces' | 'exposes' | 'mentions' | 'maps-to';
  confidence: number;
}

export interface SyntheticIntelGraph {
  generatedAt: string;
  safetyScope: string;
  nodes: IntelNode[];
  edges: IntelEdge[];
}

export function buildSyntheticOffensiveOsintGraph(seed = 'fllc-demo'): SyntheticIntelGraph {
  const nodes: IntelNode[] = [
    { id: `${seed}:domain:fllc-lab.local`, label: 'fllc-lab.local', kind: 'domain', tier: 'free', risk: 12 },
    { id: `${seed}:cert:ct-001`, label: 'CT log entry', kind: 'certificate', tier: 'free', risk: 18 },
    { id: `${seed}:asn:64512`, label: 'AS64512 lab network', kind: 'asn', tier: 'basic', risk: 26 },
    { id: `${seed}:service:https`, label: 'HTTPS service banner', kind: 'service', tier: 'basic', risk: 34 },
    { id: `${seed}:cve:demo`, label: 'CVE maturity placeholder', kind: 'cve', tier: 'premium', risk: 61 },
    { id: `${seed}:repo:evidence`, label: 'Redacted evidence repo', kind: 'repo', tier: 'premium', risk: 22 },
  ];

  const edges: IntelEdge[] = [
    { source: nodes[1].id, target: nodes[0].id, relationship: 'issued-for', confidence: 0.93 },
    { source: nodes[0].id, target: nodes[2].id, relationship: 'resolves-to', confidence: 0.78 },
    { source: nodes[2].id, target: nodes[3].id, relationship: 'announces', confidence: 0.71 },
    { source: nodes[3].id, target: nodes[4].id, relationship: 'exposes', confidence: 0.64 },
    { source: nodes[5].id, target: nodes[4].id, relationship: 'mentions', confidence: 0.56 },
  ];

  return {
    generatedAt: new Date().toISOString(),
    safetyScope: 'Synthetic data only. Replace with owned or explicitly authorized assets before production analysis.',
    nodes,
    edges,
  };
}
