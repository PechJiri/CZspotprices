L'application vous permet de recevoir des mises à jour quotidiennes sur les prix actuels de l'électricité sur le marché CZ. Elle vous permet d'ajouter les coûts de distribution à ces prix pour chaque heure et de définir les heures pendant lesquelles vous utilisez le tarif réduit. En fonction du prix ou de l'indice de prix actuel, vous pouvez contrôler vos flux et surveiller les prix grâce à des widgets interactifs.

Pour un bon fonctionnement :
1. Ajoutez l'appareil à Homey
2. Définissez les coûts de distribution pour les tarifs haut et bas
3. Spécifiez les heures pendant lesquelles le tarif réduit est disponible
4. Activez éventuellement la journalisation de débogage pour le dépannage

Les fonctionnalités de l'application :
- Surveillance des prix en temps réel via deux widgets :
  - Widget de prix de l'heure courante affichant les prix actuels, de l'heure suivante et moyens
  - Graphique interactif des prix quotidiens avec niveaux de tarifs et prix codés par couleur
- Commutation automatique sur la source de données de secours si l'API principale n'est pas disponible
- Affichage des prix en MWh ou kWh
- Support complet des flux pour l'automatisation basée sur les prix et les tarifs
- Calcul avancé des périodes de prix optimales

Les coûts de distribution seront automatiquement inclus dans les prix lors de la prochaine mise à jour. L'application utilise deux sources de données : les données principales de spotovaelektrina.cz et les données de secours de OTE-CR si nécessaire.