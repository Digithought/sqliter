---
description: Push aggregations below joins when semantically valid
difficulty: hard
prereq: Titan optimizer, aggregation planning

---

## Architecture

*Details to be filled out during planning phase.*

Aggregate pushdown optimization moves GROUP BY and aggregate functions closer to data sources when semantic equivalence is preserved. Reduces intermediate result sizes.

**Principles:** SPP, DRY, modular architecture. Validate semantic equivalence carefully.
