-- ============================================================
-- Motib HUB · Migración 005 — Actualiza el texto de Maracaibo (una vez)
-- Correr en: Supabase → SQL Editor → New query → Run
--
-- Por qué: a partir de ahora la app NO pisa los textos de cliente editados
-- (para que lo que edites desde Tomi/Ailén quede en vivo). Como Maracaibo ya
-- existía en la base, este UPDATE deja su texto nuevo una sola vez. Después,
-- editás libremente desde la app y queda guardado.
--
-- Idempotente: se puede correr más de una vez sin problema.
-- ============================================================

update clients set
  playbook = 'Gestión completa de Instagram a partir del 10 de junio — Mili pasa el material grabado. Base diaria: 2 stories/día en Maracaibo y 1 story/día en Acai Bar. Feed Maracaibo: mínimo por semana 2 reels + 1 carrusel o imagen. Acai Bar: 1 posteo por semana, en colaboración con un posteo de Maracaibo. Armado/edición del contenido según calendario mensual (mes vista).',
  cadence = 'Diario: 2 stories Maracaibo + 1 Acai Bar · Semanal: 2 reels + 1 carru/img + 1 colab Acai · gestión completa desde 10/06',
  typical_tasks = '["Stories Maracaibo (2/día)","Story Acai Bar (1/día)","Reels Maracaibo (2/sem)","Carrusel o img Maracaibo (1/sem)","Colab Acai + Maracaibo (1/sem)","Calendario mensual"]'::jsonb
where id = 'cli-maracaibo';
