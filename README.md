# 🏆 CI/CD Leaderboard

Leaderboard automatisé pour le cours CI/CD.

## Comment ça marche

1. Les équipes renseignent leur repo dans `teams.json`
2. Un workflow GitHub Actions scanne les repos toutes les 30 minutes
3. Chaque critère est vérifié via l'API GitHub
4. Les scores sont publiés sur GitHub Pages

## Leaderboard

👉 **[Voir le leaderboard](https://akaclasses.github.io/cicd-leaderboard/)**

## Critères de scoring

### 🟢 Fondamentaux (60 pts)
| Critère | Points | Vérification |
|---------|--------|-------------|
| Pipeline exists | 5 | Workflow YAML dans `.github/workflows/` |
| Pipeline green | 5 | Dernier run sur `main` est vert |
| Lint pass | 5 | Step de lint dans le pipeline |
| No secrets in code | 5 | Pas de secrets hardcodés détectés |
| Tests exist | 10 | Fichiers de test + exécution dans CI |
| Tests pass | 5 | Pipeline vert avec des tests |
| Coverage ≥ 70% | 10 | Coverage configuré dans CI |
| Dockerfile exists | 5 | `Dockerfile` à la racine |
| Docker build in CI | 5 | Step de build Docker dans le pipeline |

### 🔵 Intermédiaire (40 pts)
| Critère | Points | Vérification |
|---------|--------|-------------|
| Security scan | 10 | Trivy/Bandit/Snyk/etc. dans CI |
| Image on GHCR | 10 | Package container publié |
| Quality gate | 10 | SonarCloud/CodeClimate configuré |
| App deployed | 10 | URL publique répond HTTP 200 |

### 🟡 Avancé (30 pts)
| Critère | Points | Vérification |
|---------|--------|-------------|
| Branch protection | 5 | `main` protégée, PR obligatoire |
| Auto-deploy | 10 | Deploy automatique sur push main |
| Multiple environments | 10 | staging + prod |
| Pipeline < 3 min | 5 | Durée moyenne des derniers runs |
| Dependabot/Renovate | 5 | Config de mise à jour auto des deps |

### 🎤 Oral (20 pts)
Évalué en soutenance le vendredi.

**Total : 150 pts**

## Setup (pour le prof)

1. Créer un Personal Access Token (classic) avec les scopes : `repo`, `read:packages`
2. L'ajouter comme secret `SCORING_TOKEN` sur ce repo
3. Activer GitHub Pages (source: `docs/` branch `main`)
4. Remplir `teams.json` avec les repos des étudiants
5. Le workflow tourne automatiquement ou via "Run workflow"

## Inscription des équipes

Éditez `teams.json` et ajoutez votre équipe :

```json
{
  "team": "Nom de l'équipe",
  "members": ["prenom1", "prenom2"],
  "repo": "username/todo-api-python",
  "deploy_url": "https://votre-app.onrender.com"
}
```

Le champ `deploy_url` peut rester vide au début — remplissez-le quand votre app est déployée.
