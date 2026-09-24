import { Metrics } from "@polyroot/observability";

export class MetricsExporter {
  private metrics: Metrics;

  constructor(metrics: Metrics) {
    this.metrics = metrics;
  }

  getMetrics(): string {
    const snapshot = this.metrics.snapshot();
    let output =
      "# HELP g4_total_orders_total Total orders processed\n# TYPE g4_total_orders_total counter\n";
    output += `g4_total_orders_total ${snapshot.counters["totalOrders"] ?? 0}\n\n`;

    output +=
      "# HELP g4_filled_orders_total Total filled orders\n# TYPE g4_filled_orders_total counter\n";
    output += `g4_filled_orders_total ${snapshot.counters["filledOrders"] ?? 0}\n\n`;

    output +=
      "# HELP g4_total_pnl_total Total PnL\n# TYPE g4_total_pnl_total gauge\n";
    output += `g4_total_pnl_total ${snapshot.counters["totalPnl"] ?? 0}\n\n`;

    output +=
      "# HELP g4_total_fees_total Total fees\n# TYPE g4_total_fees_total gauge\n";
    output += `g4_total_fees_total ${snapshot.counters["totalFees"] ?? 0}\n\n`;

    output +=
      "# HELP g4_max_drawdown Max drawdown\n# TYPE g4_max_drawdown gauge\n";
    output += `g4_max_drawdown ${snapshot.gauges["maxDrawdown"] ?? 0}\n\n`;

    output += "# HELP g4_fill_ratio Fill ratio\n# TYPE g4_fill_ratio gauge\n";
    output += `g4_fill_ratio ${snapshot.gauges["fillRatio"] ?? 0}\n\n`;

    output +=
      "# HELP g4_current_exposure_usd Current exposure USD\n# TYPE g4_current_exposure_usd gauge\n";
    output += `g4_current_exposure_usd ${snapshot.gauges["currentExposureUsd"] ?? 0}\n\n`;

    output +=
      "# HELP g4_max_exposure_usd Max exposure USD\n# TYPE g4_max_exposure_usd gauge\n";
    output += `g4_max_exposure_usd ${snapshot.gauges["maxExposureUsd"] ?? 0}\n\n`;

    // Histograms
    for (const [name, values] of Object.entries(snapshot.histograms)) {
      if (values.length > 0) {
        const sum = values.reduce((a, b) => a + b, 0);
        const count = values.length;
        const avg = sum / count;
        output += `# HELP g4_${name}_sum Sum of ${name}\n# TYPE g4_${name}_sum gauge\n`;
        output += `g4_${name}_sum ${sum}\n\n`;
        output += `# HELP g4_${name}_count Count of ${name}\n# TYPE g4_${name}_count gauge\n`;
        output += `g4_${name}_count ${count}\n\n`;
        output += `# HELP g4_${name}_avg Average of ${name}\n# TYPE g4_${name}_avg gauge\n`;
        output += `g4_${name}_avg ${avg}\n\n`;
      }
    }

    return output;
  }
}
