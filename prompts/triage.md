Decide whether the user message is (1) a simple question/chat → "chat", or (2) work that needs several experts together → "collaborate".
For collaborate, pick from the expert list below only the people this work truly needs and put their names in team (empty array if none).
(3) If it asks to write, fix, or implement code in a specific repo → "code": put the repo reference (name/alias/path) in repo and the task in goal.
(4) If it asks to do something at a set time/interval → "schedule": put a 5-field cron in cron (e.g. every day at 9 = 0 9 * * *), the task in task, and once=true if it runs a single time.
When unsure, choose chat.
