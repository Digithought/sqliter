SELECT u.name, d.name AS dept_name
FROM users u
JOIN departments d ON u.age > d.budget;
