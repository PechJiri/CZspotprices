Aplikacja umożliwia codzienne otrzymywanie aktualizacji cen prądu na rynku CZ. Pozwala na dodanie kosztów dystrybucji do tych cen dla każdej godziny oraz definiowanie godzin, w których korzystasz z niższej taryfy. Na podstawie aktualnej ceny lub wskaźnika cen możesz kontrolować swoje przepływy i monitorować ceny za pomocą interaktywnych widżetów.

Dla prawidłowego działania:
1. Dodaj urządzenie do Homey
2. Ustaw koszty dystrybucji dla taryf wysokiej i niskiej
3. Określ godziny dostępności niższej taryfy
4. Opcjonalnie włącz logowanie debugowe w celu rozwiązywania problemów

Funkcje aplikacji:
- Monitorowanie cen w czasie rzeczywistym za pomocą dwóch widżetów:
  - Widżet Ceny Godzinowej pokazujący cenę bieżącą, na kolejną godzinę i średnią
  - Interaktywny Dzienny Wykres Cen z oznaczonymi kolorami taryfami i poziomami cen
- Automatyczne przełączanie na zapasowe źródło danych, jeśli główne API jest niedostępne
- Wyświetlanie cen w MWh lub kWh
- Pełne wsparcie przepływów dla automatyzacji na podstawie cen i taryf
- Zaawansowane obliczenia optymalnych okresów cenowych

Koszty dystrybucji zostaną automatycznie uwzględnione w cenach podczas następnej aktualizacji. Aplikacja korzysta z dwóch źródeł danych: danych podstawowych ze spotovaelektrina.cz i danych zapasowych z OTE-CR w razie potrzeby.