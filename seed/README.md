# Seed files

Drop the real files from Grok's build kit (`/workspace/budget-sandbox/` on ATLAS's computer) straight into this folder,
then press **Imports > Reload seed files** in the app (or run `npm run seed`). Safe to repeat.

| File | Header row the loader expects |
| --- | --- |
| `departments.csv` | `dept_id,dept_name,parent_group_id,usali_style_bucket,is_rollup_group,source` |
| `entities.csv` | `entity_id,entity_name,note` |
| `chart_of_accounts.csv` | `account,name,type,pl_report_section_in_sage_oct2026_export,revenue_source_system` |
| `budget_lines_template.csv` | `scenario,entity_id,dept_id,budget_sheet,account,line_name,kind,budget_category,summary_row,driver_2026_budget,driver_input_2026_budget,is_wage_base,m01..m12` |
| `drivers_hms_monthly_2025_2026.csv` | `month,days,available_room_nights_106_rooms,rooms_sold,transient_rooms,group_rooms,occupancy_pct,adr,revpar,room_revenue_hms,ooo_room_nights,source_note` |
| `drivers_lightspeed_covers_2025_2026.csv` | `month,lightspeed_outlet,suggested_dept_id,net_sales,guest_checks,covers,avg_per_cover,source_note` |

Lines starting with `#` are ignored. Percent drivers are stored as fractions (0.009 = 0.9%); a value above 1.5 is read as a percent.

When the real `budget_lines_template.csv` is loaded, the scenario "2027 Budget - Starter" is created and the made-up
"SAMPLE 2027 Budget" is removed. After loading, `npm test` checks the kit's counts: 424 lines, 28 tabs, 88 revenue,
336 cost, 277 accounts, 41 departments.

## `sample/`

A small stand-in set so the app runs before the real files arrive. Department names, the 2025 occupancy and ADR, and the
depreciation and amortization totals come from the build kit page. **Every other dollar amount, rate, cover count and several
account names are made up.** Do not use them for anything.
