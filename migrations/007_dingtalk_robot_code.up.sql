-- 007_dingtalk_robot_code.up.sql
-- DingTalk messaging (#49): the robot groupMessages/send API requires the
-- app robot's robotCode (a console value). The tenant's DingTalk app
-- credentials gain the field; ciphertext at rest like app_secret (written
-- encrypted by the admin API), NULL = not yet synced (messaging on this
-- tenant fails loudly with an actionable error until it is).

ALTER TABLE dingtalk_credentials ADD COLUMN robot_code TEXT;
