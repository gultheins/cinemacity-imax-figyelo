# cinemacity-imax-figyelo

A Cinema City Aréna **Odüsszeia** című filmhez tartozó IMAX-foglalási határdátumának automatikus figyelése.

A GitHub Actions óránként ellenőrzi az IMAX-ra szűrt foglalási URL-t. Ha a legkésőbbi elérhető dátum előrébb kerül, a rendszer:

1. frissíti a `state.json` állományt;
2. létrehoz egy, a repository tulajdonosához rendelt GitHub-issue-t;
3. a GitHub értesítési beállításaitól függően e-mailt küld az issue-ról.

A figyelő kizárólag az URL `at=YYYY-MM-DD` paraméterét vizsgálja. Ha a Cinema City a kért napról másik dátumra irányít vissza, azt tekinti az első még nem elérhető napnak.
