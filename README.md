# Sales Margin Tracker (Huawei Solar)

Application React + TypeScript (Vite) pour suivre les ventes, commissions et marges.

## Lancer en local

```bash
npm install
npm run dev
```

## Installer sur iPhone (PWA)

1. Ouvre l'URL de l'application dans Safari.
2. Partage -> `Ajouter a l'ecran d'accueil`.
3. Lance l'icone `Sales Manager` comme une app.

Notes:
- L'app fonctionne en mode standalone (PWA).
- Un service worker est actif pour garder l'app utilisable hors-ligne de base.

## App macOS (Electron)

Objectif: avoir une vraie app macOS (donc visible comme app, et les notifications ne seront plus "Google Chrome").

Build le DMG/ZIP:

```bash
npm run desktop:build
```

Artefacts generes:
- `dist-desktop/Huawei Sales Manager-*-arm64.dmg`
- `dist-desktop/Huawei Sales Manager-*-arm64-mac.zip`

Installation:
1. Ouvre le `.dmg`
2. Glisse `Huawei Sales Manager.app` dans `Applications`
3. Lance l'app depuis `Applications` ou Spotlight

Dev (optionnel):

```bash
npm run desktop:dev
```

## Commandes utiles

```bash
npm run test
npm run build
npm run ios:doctor
npm run ios:add
npm run ios:sync
npm run ios:open
npm run sync:ingest-email
npm run sync:ingest-stripe-event
npm run sync:poll-imap
npm run sync:worker
npm run sync:playwright-fetch-order
npm run sync:playwright-capture-state
```

## Build iPhone (Capacitor iOS)

1. Initialiser iOS (une seule fois):

```bash
npm run ios:add
```

2. Rebuild web + sync vers Xcode:

```bash
npm run ios:sync
```

3. Ouvrir Xcode:

```bash
npm run ios:open
```

4. Dans Xcode:
- Selectionner ton team/signing.
- Choisir un iPhone reel ou simulateur.
- Build/Run.

Note: `npm run ios:sync` utilise `VITE_BASE_PATH=/` pour que les assets fonctionnent en natif.

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
6. Si le projet existait deja, re-execute `supabase/schema.sql` pour creer les nouvelles tables (ex: messagerie).

L'app reste locale par defaut et active la synchro cloud automatiquement si les variables Supabase sont presentes.

Note securite: le schema applique des policies RLS basees sur l'en-tete `x-store-id` pour isoler les donnees
entre instances (pense a garder `VITE_SUPABASE_STORE_ID` unique).

## IA vocal + Stripe (paiements/payouts)

Pour eviter qu'un tiers utilise tes credits OpenAI ou lise tes donnees Stripe depuis l'URL publique, les Edge Functions
peuvent etre protegees par une cle partagee:

1. Definis ces secrets dans Supabase (Project -> Settings -> Secrets):
   - `OPENAI_API_KEY`
   - `APP_SHARED_SECRET` (valeur longue aleatoire)
   - `STRIPE_SECRET_KEY` (optionnel, pour paiements/payouts)

2. Dans l'app, ouvre `Chat` -> `IA vocal` et colle la meme valeur dans `Access key`.

3. L'IA vocal peut alors utiliser:
   - stock + commandes/KPI (depuis l'app)
   - paiements/payouts Stripe (si `STRIPE_SECRET_KEY` est configure)

## Notifications push iPhone/macOS (chat)

1. Genere des cles VAPID:

```bash
npx web-push generate-vapid-keys
```

2. Ajoute dans `.env.local`:
   - `VITE_WEB_PUSH_PUBLIC_KEY`
   - `VITE_SUPABASE_PUSH_FUNCTION_URL` (optionnel si URL par defaut convient)

3. Configure les secrets Supabase Edge Function:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `WEB_PUSH_PUBLIC_KEY`
   - `WEB_PUSH_PRIVATE_KEY`
   - `WEB_PUSH_SUBJECT`
   - `APP_BASE_URL`

4. Deploy la fonction:

```bash
supabase functions deploy chat-push-notify --project-ref YOUR_PROJECT_REF
```

5. Dans l'app, ouvre le chat et active `Push ON`.

Important iPhone: les push Web ne fonctionnent que si l'app est ajoutee a l'ecran d'accueil.

## IA vocal (OpenAI Realtime)

Objectif: parler a l'app et recevoir une reponse vocale (et transcript).

Prerequis:
- une cle OpenAI (elle reste cote Supabase, jamais dans le frontend).

1) Ajouter les secrets dans Supabase:

```bash
supabase secrets set --project-ref YOUR_PROJECT_REF \\
  OPENAI_API_KEY=sk-... \\
  OPENAI_REALTIME_MODEL=gpt-realtime \\
  OPENAI_REALTIME_VOICE=marin
```

2) Deployer la fonction (si pas deja fait):

```bash
supabase functions deploy openai-voice-token --project-ref YOUR_PROJECT_REF
```

3) Dans l'app, ouvre le chat et clique `IA vocal` puis `Demarrer`.

Notes:
- iPhone: utilise Safari + "Ajouter a l'ecran d'accueil" pour une meilleure stabilite micro.
- L'IA vocal utilise WebRTC; si un navigateur ne supporte pas, le bouton est desactive.

## Fonctionnalites

- CRUD complet des ventes avec calculs automatiques.
- Import automatique du catalogue Huawei depuis `https://yohand-byte.github.io/huawei-pricing-calculator/`.
- Gestion du stock avec blocage des ventes si stock insuffisant (produits catalogues).
- Pieces jointes par vente (base64 en localStorage) avec ajout, liste, telechargement et suppression.
- Previsualisation des PJ (PDF/image) avec fermeture in-app + telechargement optionnel.
- Dashboard KPI, filtres multi-criteres, export CSV et backup JSON.
- Sync cloud Supabase: backup auto, sync manuelle, restauration cloud.
- Messagerie interne equipe en bulle flottante + mentions `@REF` + ouverture directe onglet Stock.
- Notifications push web chat (iPhone/macOS) via Supabase Edge Function.
- Seed initial de 3 ventes d'exemple.

## Pipeline plateforme-first (en cours)

- Fondation Supabase ajoutee: `orders`, `order_lines`, `ingest_events`, `inbox_messages`, `sync_logs`.
- Parseur email Sun.store/Solartraders + script d'ingestion JSON -> Supabase.
- Documentation operationnelle: `/Users/yohanaboujdid/sales-margin-tracker/docs/platform-sync.md`.
