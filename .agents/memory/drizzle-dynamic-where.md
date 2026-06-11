---
name: Drizzle dynamic SQL WHERE clauses
description: How to build optional/conditional WHERE filters in Drizzle ORM sql-template queries
---

## Rule
Build optional filters as an array of `SQL | null` conditions and join with `sql.join(parts, sql` AND `)`. Never use the `($n IS NULL OR column = $n)` pattern for optional params — it misbehaves when all params are null.

**Why:** Drizzle's `sql` tagged-template creates a numbered parameter for every `${...}` interpolation in order. When you write `(${county} IS NULL OR d.county = ${county})`, both uses of `county` become separate parameters. With complex multi-band enrollment conditions this leads to 12+ nullable params and the query engine errors.

**How to apply:**
```typescript
import { sql, type SQL } from "drizzle-orm";

const conds: Array<SQL | null> = [
  sql`s.base_increase_pct IS NOT NULL`,           // always-on base condition
  county     ? sql`d.county = ${county}`     : null,
  yearFrom   ? sql`s.from_year >= ${yearFrom}` : null,
  band       ? bandSqlMap[band]              : null, // pre-built SQL fragment
];
const where = sql.join(conds.filter(Boolean) as SQL[], sql` AND `);

await db.execute(sql`SELECT ... FROM ... WHERE ${where}`);
```

The `bandSqlMap` pre-builds enrollment-band conditions as SQL fragments with no parameters:
```typescript
const bandSqlMap: Record<string, SQL> = {
  tiny:   sql`d.enrollment < 500`,
  small:  sql`d.enrollment BETWEEN 500 AND 999`,
  medium: sql`d.enrollment BETWEEN 1000 AND 2499`,
  large:  sql`d.enrollment BETWEEN 2500 AND 4999`,
  xlarge: sql`d.enrollment >= 5000`,
};
```
