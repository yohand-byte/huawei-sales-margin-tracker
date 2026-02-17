# Sales Margin Tracker (Huawei Solar)

Application React + TypeScript (Vite) pour suivre les ventes, commissions et marges.

## Lancer en local

```bash
npm install
npm run dev
```

## Commandes utiles

```bash
npm run test
npm run build
npm run sync:ingest-email
```

## Composant principal

- `src/components/SalesMarginTracker.tsx`

## Backend gratuit (Supabase Free)

1. Cree un projet sur Supabase (plan Free).
2. Va dans SQL Editor et execute `supabase/schema.sql`.
3. Cree `.env.local` a partir de `.env.example`.
4. Renseigne:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_SUPABASE_STORE_ID` (valeur longue/unique)
5. Redemarre `npm run dev`.

L'app reste locale par defaut et active la synchro cloud automatiquement si les variables Supabase sont presentes.

## Fonctionnalites

- CRUD complet des ventes avec calculs automatiques.
- Import automatique du catalogue Huawei depuis `https://yohand-byte.github.io/huawei-pricing-calculator/`.
- Gestion du stock avec blocage des ventes si stock insuffisant (produits catalogues).
- Pieces jointes par vente (base64 en localStorage) avec ajout, liste, telechargement et suppression.
- Dashboard KPI, filtres multi-criteres, export CSV et backup JSON.
- Sync cloud Supabase: backup auto, sync manuelle, restauration cloud.
- Seed initial de 3 ventes d'exemple.

## Pipeline plateforme-first (en cours)

- Fondation Supabase ajoutee: `orders`, `order_lines`, `ingest_events`, `inbox_messages`, `sync_logs`.
- Parseur email Sun.store/Solartraders + script d'ingestion JSON -> Supabase.
- Documentation operationnelle: `/Users/yohanaboujdid/sales-margin-tracker/docs/platform-sync.md`.
