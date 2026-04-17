-- Columna rol para diferenciar vendedor / supervisor / admin en el JWT
ALTER TABLE vendedores ADD COLUMN IF NOT EXISTS rol TEXT DEFAULT 'vendedor';

-- Marcar dev@dev.com como admin para pruebas
UPDATE vendedores SET rol = 'admin' WHERE email = 'dev@dev.com';
