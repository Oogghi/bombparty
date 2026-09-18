# Bomb Party français

Jeu de mots français multijoueur en temps réel, inspiré de Bomb Party. Le serveur est l’autorité pour les salons, l’ordre des tours, les chronomètres, les vies, le lexique et les résultats.

## Lancer en local

Pré-requis : Node.js 20 ou plus récent.

```bash
npm ci
npm test
npm start
```

Dans PowerShell verrouillé, utilise les exécutables `.cmd` équivalents :

```powershell
npm.cmd ci
npm.cmd test
npm.cmd start
```

Cette variante contourne uniquement le wrapper PowerShell bloqué ; elle ne modifie pas la stratégie d’exécution Windows.

Ouvre ensuite `http://localhost:3000` dans deux fenêtres ou deux navigateurs. Une personne crée un salon, l’autre rejoint le code affiché ou le lien copié. Pour tester depuis un autre appareil sur le même réseau, lance le serveur avec l’adresse IP locale de la machine et ouvre `http://IP_LOCALE:3000`.

Les variables disponibles sont documentées dans `.env.example` : `PORT` et `HOST` contrôlent l’écoute du serveur. Le serveur écoute sur `0.0.0.0` par défaut, ce qui convient aux hébergeurs WebSocket.

## Déploiement

Le projet utilise un serveur Node.js persistant et WebSocket : il doit être déployé sur une infrastructure qui conserve les connexions WebSocket ouvertes, par exemple Render, Fly.io, Railway ou un serveur Docker. Le `Dockerfile` et le `render.yaml` sont inclus.

Sur Render : crée un **Web Service** depuis ce dépôt, choisis l’environnement Docker et laisse le port détecté. Le endpoint `/health` sert de contrôle de santé. Le serveur garde l’état en mémoire : une instance unique est nécessaire pour partager un salon entre les joueurs ; plusieurs instances demanderaient ensuite un bus partagé (Redis, par exemple).

## Fonctionnement

- Les salons sont des codes aléatoires de six caractères et sont isolés par une `Map` serveur.
- Chaque joueur possède un identifiant et un jeton de session distincts de son pseudo. Une reconnexion dans les 90 secondes reprend la même place.
- Le serveur normalise accents/casse, refuse les mots inconnus, les doublons et les mots sans fragment, puis choisit les fragments à partir de l’index réel du lexique chargé.
- Les messages sont limités en taille et en fréquence. Le client rend les pseudos et les saisies avec `textContent`, sans HTML fourni par un joueur.
- Un joueur qui rejoint une partie déjà lancée est spectateur ; il redevient joueur au prochain départ. Le départ de l’hôte transfère automatiquement l’hôte.

## Tests exécutés

La suite intégrée se lance avec `npm test` et couvre :

- validation avec accents et changement de tour ;
- mot inconnu, fragment absent et doublon ;
- expiration du chrono, retrait d’une vie et élimination ;
- désignation du gagnant ;
- bornes des réglages et sélection d’une séquence issue du lexique chargé.

Le test de fumée multi-client recommandé après lancement consiste à ouvrir deux navigateurs distincts, créer/rejoindre un salon, lancer la partie, saisir un mot dans la fenêtre active, puis laisser expirer un tour pour vérifier la synchronisation des vies et du spectateur.
