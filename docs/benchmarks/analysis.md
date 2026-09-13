# pi-plans A/B — primary analysis (seed-1, paired, D-012)

- Pairs (tasks): **36**
- Resolve: baseline **3/36** (8.3%) vs treatment **0/36** (0.0%)
- McNemar exact: discordant b=3 (baseline-only), c=0 (treatment-only), both=33; **p = 0.2500**
- Δcost per task (treatment−baseline): mean **$0.0000**, 95% CI [$0.0000, $0.0000] (bootstrap 10k, includes parent+subagent)
- Δturns per task: mean **-3.86**, 95% CI [-7.72, -0.39]
- Δtokens per task (in+out, treatment−baseline): mean **-215,041**, 95% CI [-541,308, -13,484] — the $ columns are 0 when the provider price table is zero (zai coding plan); tokens are the cost dimension
- per resolved task: baseline **$0.0000 / 2,783,085 tok** vs treatment **$0.0000 / 0 tok**

> Exploratory: pi-plans (forced-plan-big variant) on Terminal-Bench 2.0 / GLM-5.3-Flash / single seed (D-018). No generalization beyond this configuration.