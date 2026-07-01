export interface PatchCharEfficiency {
  patchChars: number;
  baselineChars: number;
}

export function formatSelectorCostWarning(efficiency: PatchCharEfficiency): string | undefined {
  const ratio = getSelectorCostRatioPercent(efficiency);
  if (ratio === undefined || ratio <= 50) {
    return undefined;
  }
  return `Warning: selector cost is ${ratio.toFixed(1)}% of baseline. Use shorter selectors or ... ranges.`;
}

function getSelectorCostRatioPercent(efficiency: PatchCharEfficiency): number | undefined {
  if (efficiency.baselineChars === 0) {
    return undefined;
  }
  return (efficiency.patchChars / efficiency.baselineChars) * 100;
}
