description: Index JSON properties via expression indexes on json_extract paths
difficulty: hard
prereq: Expression index support (currently throws "not supported yet" in schema/manager.ts:940), json-native-object-storage
files:
  - packages/quereus/src/schema/manager.ts (expression index creation — currently blocked)
  - packages/quereus/src/planner/ (optimizer rules for index-backed JSON path queries)
----

## Overview

Enable indexing of JSON properties so queries like
`select * from t where json_extract(data, '$.email') = 'alice@example.com'`
can use an index.

This requires **expression indexes** which are not yet supported
(see `manager.ts:940` — `"Indices on expressions are not supported yet."`).
This ticket should be planned after expression index support lands.

## Use case

```sql
create table users (id integer primary key, data json);
create index idx_email on users (json_extract(data, '$.email'));

-- This query should use the index:
select * from users where json_extract(data, '$.email') = 'alice@example.com';
```

## Considerations

- Depends on expression index infrastructure (separate feature)
- Optimizer must match `json_extract(col, path)` in WHERE to the expression index
- With `->` / `->>` operators, `data ->> '$.email'` should also match
- Index values are the extracted scalar, not the full JSON object
- NULL handling: if the path doesn't exist, the index entry is NULL
