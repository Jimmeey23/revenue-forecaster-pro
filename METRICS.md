# P57 Dashboard — Metric Calculations

All metrics computed client-side in `src/main.js` from pre-built JSON embedded in the file.
Source data flows: CSV files → build scripts → `assets/sales-drill-index.js` + `assets/raw-drill-index.js` + `APP` object embedded in `src/main.js`.

---

## Data sources (CSV filenames after rename)

| File | Used for |
|---|---|
| `Sales.csv` | All revenue metrics, product/category mix, buyer counts, ATV, AUV |
| `Sessions.csv` | Attendance, fill rate, class avg, formats, trainer sessions |
| `New Visitors.csv` | New member counts, conversion, retention, source attribution |
| `Leads.csv` | CRM lead pipeline, lead source, trial/won stage |
| `Lapsed.csv` | Churn metrics, membership expiry/renewal/lapse |
| `Recurring.csv` | Recurring membership context (not yet wired to a build script) |
| `Payroll.csv` | Payroll context (not yet wired to a build script) |
| `Checkins.csv` | Check-in data (not yet wired to a build script) |
| `Lapsed Unique.csv` | Unique lapsed member data (not yet wired to a build script) |
| `Teacher Recurring (4).csv` | Teacher recurring data (not yet wired to a build script) |

---

## Revenue metrics

### Net Sales (`salesRev`)
```
SUM(Payment Value) for selected studio and month
```
Source: `Sales.csv` → rows where `Payment Status` is not failed/void/cancelled/refund, filtered by studio (`Calculated Location` or `Home Location`) and month (`Payment Date`).

### Session Revenue (`sessionRev`)
```
SUM(Revenue) from Sessions.csv rows for selected studio and month
```
Source: `Sessions.csv` → `Revenue` column summed per period+studio.

### New Revenue (`newRevenue`)
```
SUM(Payment Value) where Purchase Tag = 'New'
```
Source: `Sales.csv` → rows tagged `New` in `Purchase Tag` column.

### ATV — Average Transaction Value
```
Net Sales / COUNT(DISTINCT Payment Transaction ID)
```
i.e. revenue divided by number of receipts (transactions).

### AUV — Average Unit Value
```
Net Sales / COUNT(DISTINCT purchasing members)
```
i.e. revenue per unique member who bought.

### Purchase Frequency
```
COUNT(all sale line items) / COUNT(DISTINCT purchasing members)
```
Items per buyer in the period.

### Revenue per Class (`revenuePerClass`)
```
Session Revenue / COUNT(sessions)
```
Computed per class name and per trainer.

---

## Schedule / attendance metrics

### Class Average (`classAvg`)
```
SUM(CheckedIn) / COUNT(SessionID)
```
Average bodies per session, including empty sessions.

### Fill Rate (`fillRate`)
```
SUM(CheckedIn) / SUM(Capacity)
```
Weighted fill across all sessions.

### Empty Classes
```
COUNT(sessions where CheckedIn = 0)
```

### Late Cancellations
```
SUM(LateCancelled) from Sessions.csv
```

### Booked
```
SUM(Booked) from Sessions.csv
```

### Class avg excl. empty (trainer scoreboard)
```
SUM(CheckedIn) / COUNT(sessions where CheckedIn > 0)
```

---

## Acquisition metrics

### New Members / First Visits (`newMembers`)
```
COUNT(rows in New Visitors.csv where "Is New" starts with "New")
```
Filtered by First Visit Location and First Visit Date matching selected period+studio.

### Clients Converted (`converted`)
```
COUNT(new members where Conversion Status = 'Converted')
```

### Conversion Rate (`conversionRate`)
```
Converted new members / New members
```

### Retention Rate (`retentionRate`)
```
Retained new members / New members
```

### Lead Yield
```
New members / CRM leads created in selected month
```
Source: `Leads.csv` leads count for studio+period.

### Lead Trial Rate
```
Leads who had a trial / Total leads
```

### Lead Win Rate
```
Leads marked Won / Total leads
```

### Source LTV
```
SUM(Ltv) for new members from that source / COUNT(new members from source)
```

---

## Retention / churn metrics

### Churn Risk (`churnRate`)
```
Lapsed paid memberships / Expiring paid memberships
```
Source: `Lapsed.csv` → rows grouped by membership name, filtered to paid memberships (excludes complementary/free via `excludedMembership()`). Expiring = all rows with End Date in the period. Lapsed = subset where Status = lapsed/churned.

### Renewal Rate
```
Renewed memberships / Expiring paid memberships
= 1 - Churn Rate (approximately, frozen memberships treated separately)
```

### Churn Risk Score (watchlist ranking)
```
expiring × churnRate
```
Higher score = more exposed members. Used to sort the Retention Risk Watchlist.

### Churn Risk Band
```
High   → churnRate ≥ 0.25, OR (expiring ≥ 40 AND churnRate ≥ 0.18)
Medium → churnRate ≥ 0.15, OR avgSessionsPerMonth < 2
Watch  → everything else
```

### Churn Action (recommended action label)
```
churnRate ≥ 0.20 AND avgSessionsPerMonth < 2  → "Call low-usage expiries"
churnRate ≥ 0.20                               → "Renewal save offer"
renewRate ≥ 0.75                               → "Protect renewal script"
avgSessionsPerMonth < 2                        → "Usage reactivation"
else                                           → "Monitor next cycle"
```

---

## Trainer metrics

### Trainer Score
```
classAvg × 0.45 + fillRate × 8 + conversionRate × 6 + LN(revenue + 1) / 5
```
Composite score used to rank trainers on the scoreboard.

### Trainer fill / avg / attendance
Computed from `Sessions.csv` rows filtered by `Trainer` name for the period+studio.

---

## Studio Health Score (cockpit summary)

Composite 0–100 score, shown in the cockpit header brief:

```
revenueRaw   = clamp(0,100,  50 + salesRevGrowthPct × 100 )
acquisitionRaw = clamp(0,100,  conversionRate × 170 + leadYield × 40 )
scheduleRaw  = clamp(0,100,  fillRate × 135 + classAvg × 3 − emptyClasses × 4 )
retentionRaw = clamp(0,100,  renewalRate × 115 − churnRate × 130 )

score = ROUND( revenueRaw×0.30 + acquisitionRaw×0.20 + scheduleRaw×0.25 + retentionRaw×0.25 )
```

Bands: ≥ 82 = Strong, ≥ 72 = Improving, < 72 = Needs intervention.

---

## Month-over-month growth

All `growth` values are relative change vs prior month:
```
growth[key] = (current[key] − previous[key]) / |previous[key]|
```
Rate-based metrics (fillRate, conversionRate, churnRate, etc.) are shown as percentage-point change (pp), not relative %.

---

## Derived display values

| Display | Calculation |
|---|---|
| Members (`buyers`) | COUNT(DISTINCT purchasing member IDs) from Sales.csv |
| Transactions | COUNT(DISTINCT Payment Transaction IDs) |
| Sales Items (`salesItems`) | COUNT(all sale line rows) |
| Active instructors | COUNT(DISTINCT Trainer) from Sessions.csv |
| Sessions (`classes`) | COUNT(SessionID rows) |
| Expiring memberships | COUNT(Lapsed.csv rows with End Date in period) |
| Active memberships | Expiring − Lapsed − Frozen |
| Frozen memberships | COUNT(rows where Status = frozen) |
| Avg sessions/month (`avgSessionsPerMonth`) | Total sessions completed / months of membership |
