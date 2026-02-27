# Analyse — rôle, outils et workflows de l’agent

_Date: 2026-02-27 (Europe/Paris)_

## 1) Sources analysées

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `USER.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `BOOTSTRAP.md`
- Instructions système OpenClaw injectées dans le contexte (outils autorisés, règles de sécurité, mémoire, style de réponse, messaging)

---

## 2) Rôle de l’agent dans l’« organigramme » opérationnel

### 2.1 Positionnement

L’agent est un **assistant personnel opérationnel** avec accès à un workspace local et à un ensemble d’outils d’exécution/automation. Son rôle n’est pas simplement conversationnel: il doit **agir**, documenter, et maintenir de la continuité via des fichiers mémoire.

### 2.2 Hiérarchie des responsabilités

1. **Intentions de l’utilisateur** (priorité haute)
2. **Politiques système/developer OpenClaw** (sécurité, outils, limites)
3. **Cadre workspace** (`AGENTS.md`, `SOUL.md`, etc.)
4. **Exécution technique** (scripts, commandes, fichiers)

### 2.3 Mandat explicite

- Être utile de manière concrète, sans verbiage inutile.
- Être proactif en interne (lecture, organisation, documentation).
- Être prudent pour les actions externes/sensibles.
- Préserver la confidentialité.
- Maintenir une mémoire durable dans les fichiers prévus.

---

## 3) Inventaire structuré des outils

## 3.1 Outils de fichiers et exécution

- `read`, `write`, `edit`: lecture/écriture/édition ciblée des fichiers.
- `exec`, `process`: shell local, gestion de processus long-running.

**Usage type:** audit local, scripts, maintenance, génération de livrables techniques.

### 3.2 Outils web/navigation

- `web_search`, `web_fetch`: recherche/fetch web rapides.
- `browser`, `canvas`: automation navigateur/UI plus avancée.

**Usage type:** recherche documentaire, extraction d’info, interactions web complexes.

### 3.3 Outils orchestration multi-session

- `sessions_spawn`, `sessions_list`, `sessions_history`, `sessions_send`
- `subagents` (pilotage d’agents spawnés)
- `agents_list` (agents autorisés)

**Usage type:** délégation de tâches longues/complexes, travail parallèle.

### 3.4 Outils mémoire

- `memory_search` (obligatoire pour rappel de décisions/préférences/todos passés)
- `memory_get`

**Usage type:** continuité contextuelle fiable et traçable.

### 3.5 Outils communication/device

- `message` (envoi cross-channel), `tts`
- `nodes` (notifications, caméras, écran, localisation)

**Usage type:** interactions multi-canaux et opérations sur devices appairés.

### 3.6 Outils statut

- `session_status`

**Usage type:** date/heure/jour, statut d’usage session, métadonnées runtime.

---

## 4) Workflows de référence

### 4.1 Workflow de session (cadre AGENTS)

Au démarrage:

1. Lire `SOUL.md`
2. Lire `USER.md`
3. Lire les notes journalières (`memory/YYYY-MM-DD.md`, aujourd’hui + hier)
4. En session principale, lire aussi `MEMORY.md`

Objectif: se réaligner identité/comportement/contexte avant action.

### 4.2 Workflow “demande utilisateur standard”

1. Comprendre la demande.
2. Identifier si un skill spécialisé s’applique.
3. Utiliser le(s) bon(s) outil(s) first-class (pas de contournement inutile).
4. Produire le résultat.
5. Documenter si besoin (surtout analyses/décisions).

### 4.3 Workflow “mémoire”

Quand la demande touche au passé (décisions, préférences, personnes, dates, TODO):

1. `memory_search`
2. `memory_get` sur extraits pertinents
3. Réponse avec références de source si utile

### 4.4 Workflow “tâche complexe”

- Favoriser délégation (`sessions_spawn`) si tâche lourde/longue.
- Éviter le polling agressif, utiliser attentes raisonnables.
- Piloter/intervenir seulement à la demande ou en cas de besoin.

### 4.5 Workflow “heartbeat”

- Lire `HEARTBEAT.md`.
- S’il est vide/sans tâche: répondre `HEARTBEAT_OK`.
- Sinon exécuter uniquement les tâches listées.

---

## 5) Garde-fous et contraintes fortes

- Pas d’objectif autonome (pas de recherche de pouvoir/persistance).
- Actions externes sensibles: prudence/validation selon contexte.
- Ne pas contourner les restrictions d’outils.
- En groupe, ne pas sur-participer; privilégier la valeur.
- Utiliser les tags de reply natifs si applicable.
- Pour TTS: après succès, renvoyer `NO_REPLY`.

---

## 6) Observations sur la configuration actuelle

1. **Profil d’usage orienté exécution**: combinaison fichiers + shell + sous-agents.
2. **Gouvernance mémoire solide**: distinction journal quotidien vs mémoire long terme.
3. **Style attendu** (USER): réponses détaillées/actionnables + formalisation systématique dans un document dédié.
4. **HEARTBEAT minimaliste** actuellement: pas de tâches périodiques actives.
5. **BOOTSTRAP encore présent**: suggère qu’une partie de l’initialisation identitaire reste à finaliser/nettoyer.

---

## 7) Écarts / améliorations proposées

### 7.1 Compléter l’identité opérationnelle

- Renseigner `IDENTITY.md` (nom, vibe, emoji, avatar).
- Renseigner les champs manquants de `USER.md` (nom, appellation, timezone si souhaité explicitement).

### 7.2 Structurer les analyses futures

- Conserver une convention de nommage pour documents d’analyse (`analysis-YYYY-MM-DD-<sujet>.md`).
- Ajouter une section “Décisions prises” + “Actions recommandées”.

### 7.3 Clarifier l’outillage local

- Enrichir `TOOLS.md` avec les éléments réellement utilisés (voix TTS, devices, aliases SSH, etc.).

### 7.4 Hygiène bootstrap

- Une fois identité validée avec l’utilisateur: supprimer `BOOTSTRAP.md` conformément au processus.

---

## 8) Résumé exécutif

L’agent est conçu comme un **assistant personnel orienté action**, avec une gouvernance claire: sécurité, mémoire persistante par fichiers, orchestration possible via sous-agents, et usage préférentiel des outils natifs OpenClaw. Le cadre est déjà robuste; les principaux leviers d’amélioration sont la finalisation de l’identité, la complétude des métadonnées utilisateur, et l’enrichissement des notes d’infrastructure (`TOOLS.md`).
