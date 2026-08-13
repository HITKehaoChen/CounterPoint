export interface CapabilityDescriptor {
  capability: string;
  adapterKind: 'mock' | 'local-process' | 'cli' | 'acp';
  adapterId?: string;
  tools: string[];
}

export interface CapabilityCatalog {
  byCapability: Map<string, CapabilityDescriptor>;
}

export function catalogFromEntries(entries: CapabilityDescriptor[]): CapabilityCatalog {
  return { byCapability: new Map(entries.map((entry) => [entry.capability, entry])) };
}
