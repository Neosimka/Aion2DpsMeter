# Aion2DpsMeter

DPS meter en overlay pour **AION 2** (client PC Windows), en français par défaut.

Basé sur [A2Tools DPS Meter](https://github.com/taengu/A2Tools-DPS-Meter) de taengu, sous licence **GPL-3.0**.
Le moteur de capture et de décodage vient d'A2Tools, et tout le mérite leur en revient. Leur README d'origine est dans [README_A2TOOLS.md](README_A2TOOLS.md).
Ce projet reste sous GPL-3.0 : si tu le distribues, le code doit rester public.

## Ce qui change par rapport à A2Tools

- **Nom et installation séparés :** « Aion2DpsMeter » s'installe à côté d'A2Tools sans l'écraser.
- **Français au premier lancement :** l'interface, les noms de compétences et de monstres, et la fenêtre Npcap.
- **Trois thèmes maison :** Éther doré (par défaut), Néon et Braise.
- **Mises à jour depuis ce dépôt :** le meter ne va jamais chercher les mises à jour d'A2Tools.

## Installer le meter

1. Installe **Npcap** depuis [npcap.com](https://npcap.com/#download). Coche « WinPcap API-compatible Mode » et laisse « Restrict to Administrators » décoché.
2. Télécharge le `.msi` dans l'onglet **Releases** de ce dépôt et installe-le.
3. Lance Aion 2 puis Aion2DpsMeter.

## Compiler une nouvelle version (GitHub Actions)

1. Ouvre l'onglet **Actions**.
2. Choisis « Aion2DpsMeter - Compiler l'installateur Windows ».
3. Clique sur **Run workflow**.

Au bout de 15 à 25 minutes, le `.msi` apparaît dans **Releases**. Le fichier `latest.json` est mis à jour, et les meters déjà installés proposent alors la mise à jour.
Pense à augmenter `version` dans `src-tauri/tauri.conf.json` et `package.json` à chaque nouvelle version.

## Récupérer les correctifs d'A2Tools (après un patch du jeu)

```bash
git fetch upstream
git merge upstream/main
```

## Avertissement

Le meter lit passivement le trafic réseau du jeu, sans injection ni modification de fichiers. Les outils tiers peuvent malgré tout être contraires aux conditions d'utilisation de NCSoft. Tu l'utilises à tes risques.
