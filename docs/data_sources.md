# Data sources and attribution

CareCast includes real national aggregate observations from Our World in Data's COVID-19 compilation. The selected source repository revision is `dc00e7296b17ab5548092c9e388b6fac6751f095`. Upstream bytes were retrieved on 7 October 2026. The analytical window is 1 January 2021 to 28 February 2022; a small amount of preceding vaccination reporting is retained for past-only alignment at the window boundary.

## Included data

| Source | Included fields | Local observations |
| --- | --- | --- |
| OWID hospitalizations compilation | National hospital occupancy, ICU occupancy, and the corresponding per-million indicators | 8,480 indicator rows |
| OWID country vaccination reports | Total vaccine doses, people fully vaccinated, original source URL and report date | 1,270 country report rows |

The five countries are Portugal, France, Italy, the Netherlands and Spain. Published count values are retained. The raw vaccination snapshots also preserve their vaccine labels and source URLs; these labels are reporting metadata rather than biological sequence or experimental data.

## Source documentation

- [OWID COVID-19 data documentation and data-reuse terms](https://github.com/owid/covid-19-data/blob/dc00e7296b17ab5548092c9e388b6fac6751f095/public/data/README.md)
- [Hospital and ICU source locations](https://github.com/owid/covid-19-data/blob/dc00e7296b17ab5548092c9e388b6fac6751f095/public/data/hospitalizations/locations.csv)
- [Country vaccination reports](https://github.com/owid/covid-19-data/tree/dc00e7296b17ab5548092c9e388b6fac6751f095/public/data/vaccinations/country_data)
- [Vaccination variable definitions](https://github.com/owid/covid-19-data/blob/dc00e7296b17ab5548092c9e388b6fac6751f095/public/data/vaccinations/README.md)

The national sources include Portugal's Direção-Geral da Saúde, France's public-health reporting, Italy's Department of Civil Protection, the Netherlands' public-health reporting and Spain's Ministry of Health. Exact country source locations are maintained by OWID; individual vaccination report URLs are retained in `data/raw/vaccinations.csv`.

## Citation

Mathieu, E., Ritchie, H., Rodés-Guirao, L., Appel, C., Giattino, C., Hasell, J., Macdonald, B., Dattani, S., Beltekian, D., Ortiz-Ospina, E., and Roser, M. Coronavirus Pandemic (COVID-19). Our World in Data. [ourworldindata.org/coronavirus](https://ourworldindata.org/coronavirus).

Mathieu, E., Ritchie, H., Ortiz-Ospina, E., et al. A global database of COVID-19 vaccinations. Nature Human Behaviour (2021). [doi:10.1038/s41562-021-01122-8](https://doi.org/10.1038/s41562-021-01122-8).

## Reuse terms

OWID's original compilation and documentation are made available under CC BY 4.0. Data originating from third-party national sources retain their own applicable terms. The MIT license in this project applies to CareCast code, not to the underlying national observations. Preserve the attribution and source links when reusing this snapshot, and consult original source terms for further redistribution.

This repository archive stopped receiving updates in August 2024. CareCast explicitly uses a historical period and does not describe this snapshot as current surveillance. All input data are public national statistics; no personal or clinical record is included.

## Why this dataset

The selected target is daily **occupied** hospital and ICU beds, rather than admissions or total available beds. The fixed January 2021-February 2022 window contains 424 daily observations for each of five countries, with complete occupancy targets in the bundled panel. Keeping this common window avoids comparing methods on different holdout dates and provides a compact source snapshot that can be inspected and rebuilt offline.

| Candidate | Relevant measurements | Decision for this study |
| --- | --- | --- |
| OWID COVID-19 archive | Harmonized national daily hospital/ICU occupancy, per-million occupancy and country vaccination reports | Selected: directly matches the target and supports a reproducible pinned snapshot |
| ECDC historical hospital/ICU dataset | Country-level occupancy and admission rates, with daily or weekly dates | Suitable for independent historical comparison; the old dataset ceased updates on 1 December 2023 |
| WHO COVID-19 dashboard | Aggregate weekly hospital and ICU admissions | Useful for a separate admissions study; admissions are a flow and cannot be substituted for occupied beds |
| Eurostat health-care resources | Annual national and regional hospital-bed counts and density | Useful resource context; annual available beds cannot serve as daily COVID-19 occupancy |

Primary comparison sources:

- [ECDC hospital and ICU dataset](https://www.ecdc.europa.eu/en/publications-data/download-data-hospital-and-icu-admission-rates-and-current-occupancy-covid-19)
- [WHO data definitions and downloads](https://data.who.int/dashboards/covid19/data)
- [Eurostat health-care resource metadata](https://ec.europa.eu/eurostat/cache/metadata/EN/hlth_rs_h_esms.htm)
- [OWID archive status](https://github.com/owid/covid-19-data)

These alternatives were compared as source choices; their files are not presented as inputs to the included forecasts. The implemented study uses only the two raw OWID snapshot files listed above. The archive's last data update was 19 August 2024. All selected fields are public national aggregates; no individual-level clinical record, sample, sequence or laboratory procedure is used.

