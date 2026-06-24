import mysql from 'mysql2/promise';

export const pool = mysql.createPool({
  host:                  process.env.DB_HOST || 'localhost',
  port:                  parseInt(process.env.DB_PORT || '3306') || 3306,
  user:                  process.env.DB_USER || 'xiadmin',
  password:              process.env.DB_PASS || 'changeme',
  database:              process.env.DB_NAME || 'xidb',
  waitForConnections:    true,
  connectionLimit:       10,
  queueLimit:            0,
  enableKeepAlive:       true,
  keepAliveInitialDelay: 0,
});
