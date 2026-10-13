// Connexion à la base Supabase qui stocke l'historique partagé.
// La clé ci-dessous est une clé « publishable » : elle est faite pour être publique,
// les droits sont limités par les règles de sécurité de la base.
window.CEMANTIX_CONFIG = {
  supabaseUrl: "https://ikvkdrbjhljedvyvjgbr.supabase.co",
  supabaseKey: "sb_publishable_o8WAL1imXpVCxS6hYM5eeQ_ZARoi0c2",
  // Jour n°1 du jeu (heure de Paris). Doit correspondre à la base et à tools/generate.py.
  startDate: "2026-10-13",
};
