-- Keep recently consumed OAuth transactions in the rate-limit window.
ALTER TABLE mail_auth_transactions ADD COLUMN consumed_at INTEGER;
