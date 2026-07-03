export interface PatchCharEfficiency {
  patchChars: number;
  baselineChars: number;
}

export function formatSelectorCost(efficiency: PatchCharEfficiency): string | undefined {
  const ratio = getSelectorCostRatioPercent(efficiency);
  if (ratio === undefined) {
    return undefined;
  }
  return `Selector cost: ${ratio.toFixed(1)}%`;
}

function getSelectorCostRatioPercent(efficiency: PatchCharEfficiency): number | undefined {
  if (efficiency.baselineChars === 0) {
    return undefined;
  }
  return (efficiency.patchChars / efficiency.baselineChars) * 100;
}
