-- `users.id` is the primary key, so it functionally determines `name` and
-- `rule-groupby-fd-simplification` drops `name` from the GROUP BY, re-emitting it
-- as a picker `min(name)`. A picker lands in the aggregate block, behind the
-- surviving key, so this select list's order is only preserved by the rule's
-- order-restoring PROJECT cap. Golden for that capped shape.
SELECT name, id, COUNT(*) AS c
FROM users
GROUP BY name, id;
