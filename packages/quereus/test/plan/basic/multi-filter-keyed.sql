SELECT * FROM (SELECT * FROM users WHERE age > 20) AS u WHERE u.id = 3 AND u.dept_id = 1;
