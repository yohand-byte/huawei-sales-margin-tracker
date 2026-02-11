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
```

## Composant principal

- `src/components/SalesMarginTracker.tsx`

## Fonctionnalites

- CRUD complet des ventes avec calculs automatiques.
- Import automatique du catalogue Huawei depuis `https://yohand-byte.github.io/huawei-pricing-calculator/`.
- Gestion du stock avec blocage des ventes si stock insuffisant (produits catalogues).
- Pieces jointes par vente (base64 en localStorage) avec ajout, liste, telechargement et suppression.
- Dashboard KPI, filtres multi-criteres, export CSV et backup JSON.
- Seed initial de 3 ventes d'exemple.
