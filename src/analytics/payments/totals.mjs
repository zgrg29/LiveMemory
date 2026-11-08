/**
 * Currency totals are always kept per (currency, value kind).
 * "actual" is money the viewer really paid; "display" is the nominal value a
 * platform shows for a gift. They are never added together, because mixing them
 * would silently overstate support.
 */
export function groupCurrencyTotals(rows) {
  const byCurrency = new Map();
  for (const row of rows) {
    const currency = String(row.currency ?? 'CNY');
    const entry = byCurrency.get(currency) ?? {
      currency,
      actualMinor: 0,
      displayMinor: 0,
      actualEventCount: 0,
      displayEventCount: 0,
      eventCount: 0
    };
    const amount = Number(row.total_minor) || 0;
    const count = Number(row.event_count) || 0;
    if (row.value_kind === 'actual') {
      entry.actualMinor += amount;
      entry.actualEventCount += count;
    } else if (row.value_kind === 'display') {
      entry.displayMinor += amount;
      entry.displayEventCount += count;
    }
    entry.eventCount = entry.actualEventCount + entry.displayEventCount;
    byCurrency.set(currency, entry);
  }
  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export function sumActualMinor(rows) {
  return rows.reduce((total, row) => total + (Number(row.actualMinor) || 0), 0);
}
