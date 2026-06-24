// AUTO-GENERATED sample data for salary-grid mockups (DO NOT hand-edit).
  // Mirrors GET /api/dashboard/districts/:id/salary-schedules response shape.
  // Teachers + single-column families are REAL Joliet contract 661 data.
  // Custodial unit is REPRESENTATIVE (illustrative job-class 'columns' grid) to
  // demonstrate the laneKind='columns' path where BA/MA chrome must NEVER appear.

  export type SalaryCell = { stepLabel: string; stepOrder: number; laneLabel: string | null; laneOrder: number; salary: number };
  export type LaneKind = 'education' | 'columns' | null;
  export type SalarySchedule = {
    id: number; scheduleName: string; schoolYear: string; startYear: number | null;
    scheduleType: string; laneLabels: string[] | null; laneKind: LaneKind;
    stepCount: number | null; laneCount: number | null;
    minSalary: number | null; maxSalary: number | null;
    sourceUrl: string | null; pageStart: number | null; pageEnd: number | null;
    cells: SalaryCell[];
  };
  export type SalarySummary = { scheduleName: string; schoolYear: string; baseSalary: number | null; maBaseSalary: number | null; maxSalary: number | null } | null;
  export type SalaryResponse = {
    bargainingUnit: string; contractId: number | null;
    schedules: SalarySchedule[]; jobFamilies: string[]; schoolYears: string[];
    summary: SalarySummary; availableUnits: string[];
  };

  export const UNIT_LABELS: Record<string,string> = {"teachers":"Teachers","custodial":"Custodial & Maintenance"};
  export const DISTRICT_NAME = "Joliet Township HSD 204";
  
  export const SALARY_BY_UNIT: Record<string, SalaryResponse> = {
  "teachers": {
    "bargainingUnit": "teachers",
    "contractId": 661,
    "schedules": [
      {
        "id": 13,
        "scheduleName": "Counselors/Social Workers",
        "schoolYear": "2025-2026",
        "startYear": 2025,
        "scheduleType": "single_column",
        "laneLabels": null,
        "laneKind": null,
        "stepCount": 36,
        "laneCount": 1,
        "minSalary": 59539,
        "maxSalary": 124533,
        "sourceUrl": "https://example.org/joliet-cba-2025-2028.pdf",
        "pageStart": 42,
        "pageEnd": 45,
        "cells": [
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 59539
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 60862
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 62186
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 63509
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 64830
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 66155
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 67480
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 68803
          },
          {
            "stepLabel": "8",
            "stepOrder": 8,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 70125
          },
          {
            "stepLabel": "9",
            "stepOrder": 9,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 71463
          },
          {
            "stepLabel": "10",
            "stepOrder": 10,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 72693
          },
          {
            "stepLabel": "11",
            "stepOrder": 11,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 74311
          },
          {
            "stepLabel": "12",
            "stepOrder": 12,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 75924
          },
          {
            "stepLabel": "13",
            "stepOrder": 13,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 77541
          },
          {
            "stepLabel": "14",
            "stepOrder": 14,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 79158
          },
          {
            "stepLabel": "15",
            "stepOrder": 15,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 80774
          },
          {
            "stepLabel": "16",
            "stepOrder": 16,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 82927
          },
          {
            "stepLabel": "17",
            "stepOrder": 17,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 85079
          },
          {
            "stepLabel": "18",
            "stepOrder": 18,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 87232
          },
          {
            "stepLabel": "19",
            "stepOrder": 19,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 89387
          },
          {
            "stepLabel": "20",
            "stepOrder": 20,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 91542
          },
          {
            "stepLabel": "21",
            "stepOrder": 21,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 93695
          },
          {
            "stepLabel": "22",
            "stepOrder": 22,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 95849
          },
          {
            "stepLabel": "23",
            "stepOrder": 23,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 98004
          },
          {
            "stepLabel": "24",
            "stepOrder": 24,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 100156
          },
          {
            "stepLabel": "25",
            "stepOrder": 25,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 102161
          },
          {
            "stepLabel": "26",
            "stepOrder": 26,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 104202
          },
          {
            "stepLabel": "27",
            "stepOrder": 27,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 106286
          },
          {
            "stepLabel": "28",
            "stepOrder": 28,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 108415
          },
          {
            "stepLabel": "29",
            "stepOrder": 29,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 110583
          },
          {
            "stepLabel": "30",
            "stepOrder": 30,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 112794
          },
          {
            "stepLabel": "31",
            "stepOrder": 31,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 115050
          },
          {
            "stepLabel": "32",
            "stepOrder": 32,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 117351
          },
          {
            "stepLabel": "33",
            "stepOrder": 33,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 119697
          },
          {
            "stepLabel": "34",
            "stepOrder": 34,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 122091
          },
          {
            "stepLabel": "35",
            "stepOrder": 35,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 124533
          }
        ]
      },
      {
        "id": 14,
        "scheduleName": "Counselors/Social Workers",
        "schoolYear": "2026-2027",
        "startYear": 2026,
        "scheduleType": "single_column",
        "laneLabels": null,
        "laneKind": null,
        "stepCount": 36,
        "laneCount": 1,
        "minSalary": 60629,
        "maxSalary": 126812,
        "sourceUrl": "https://example.org/joliet-cba-2025-2028.pdf",
        "pageStart": 42,
        "pageEnd": 45,
        "cells": [
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 60629
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 61976
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 63324
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 64671
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 66016
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 67366
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 68715
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 70062
          },
          {
            "stepLabel": "8",
            "stepOrder": 8,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 71408
          },
          {
            "stepLabel": "9",
            "stepOrder": 9,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 72771
          },
          {
            "stepLabel": "10",
            "stepOrder": 10,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 74023
          },
          {
            "stepLabel": "11",
            "stepOrder": 11,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 75671
          },
          {
            "stepLabel": "12",
            "stepOrder": 12,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 77313
          },
          {
            "stepLabel": "13",
            "stepOrder": 13,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 78960
          },
          {
            "stepLabel": "14",
            "stepOrder": 14,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 80607
          },
          {
            "stepLabel": "15",
            "stepOrder": 15,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 82252
          },
          {
            "stepLabel": "16",
            "stepOrder": 16,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 84445
          },
          {
            "stepLabel": "17",
            "stepOrder": 17,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 86636
          },
          {
            "stepLabel": "18",
            "stepOrder": 18,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 88828
          },
          {
            "stepLabel": "19",
            "stepOrder": 19,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 91023
          },
          {
            "stepLabel": "20",
            "stepOrder": 20,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 93217
          },
          {
            "stepLabel": "21",
            "stepOrder": 21,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 95410
          },
          {
            "stepLabel": "22",
            "stepOrder": 22,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 97603
          },
          {
            "stepLabel": "23",
            "stepOrder": 23,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 99797
          },
          {
            "stepLabel": "24",
            "stepOrder": 24,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 101989
          },
          {
            "stepLabel": "25",
            "stepOrder": 25,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 104031
          },
          {
            "stepLabel": "26",
            "stepOrder": 26,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 106109
          },
          {
            "stepLabel": "27",
            "stepOrder": 27,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 108231
          },
          {
            "stepLabel": "28",
            "stepOrder": 28,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 110399
          },
          {
            "stepLabel": "29",
            "stepOrder": 29,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 112607
          },
          {
            "stepLabel": "30",
            "stepOrder": 30,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 114858
          },
          {
            "stepLabel": "31",
            "stepOrder": 31,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 117155
          },
          {
            "stepLabel": "32",
            "stepOrder": 32,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 119499
          },
          {
            "stepLabel": "33",
            "stepOrder": 33,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 121887
          },
          {
            "stepLabel": "34",
            "stepOrder": 34,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 124325
          },
          {
            "stepLabel": "35",
            "stepOrder": 35,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 126812
          }
        ]
      },
      {
        "id": 15,
        "scheduleName": "Counselors/Social Workers",
        "schoolYear": "2027-2028",
        "startYear": 2027,
        "scheduleType": "single_column",
        "laneLabels": null,
        "laneKind": null,
        "stepCount": 36,
        "laneCount": 1,
        "minSalary": 61442,
        "maxSalary": 128512,
        "sourceUrl": "https://example.org/joliet-cba-2025-2028.pdf",
        "pageStart": 42,
        "pageEnd": 45,
        "cells": [
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 61442
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 62807
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 64173
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 65538
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 66901
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 68269
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 69636
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 71001
          },
          {
            "stepLabel": "8",
            "stepOrder": 8,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 72365
          },
          {
            "stepLabel": "9",
            "stepOrder": 9,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 73746
          },
          {
            "stepLabel": "10",
            "stepOrder": 10,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 75015
          },
          {
            "stepLabel": "11",
            "stepOrder": 11,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 76685
          },
          {
            "stepLabel": "12",
            "stepOrder": 12,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 78349
          },
          {
            "stepLabel": "13",
            "stepOrder": 13,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 80018
          },
          {
            "stepLabel": "14",
            "stepOrder": 14,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 81688
          },
          {
            "stepLabel": "15",
            "stepOrder": 15,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 83355
          },
          {
            "stepLabel": "16",
            "stepOrder": 16,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 85577
          },
          {
            "stepLabel": "17",
            "stepOrder": 17,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 87797
          },
          {
            "stepLabel": "18",
            "stepOrder": 18,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 90019
          },
          {
            "stepLabel": "19",
            "stepOrder": 19,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 92243
          },
          {
            "stepLabel": "20",
            "stepOrder": 20,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 94467
          },
          {
            "stepLabel": "21",
            "stepOrder": 21,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 96689
          },
          {
            "stepLabel": "22",
            "stepOrder": 22,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 98911
          },
          {
            "stepLabel": "23",
            "stepOrder": 23,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 101135
          },
          {
            "stepLabel": "24",
            "stepOrder": 24,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 103356
          },
          {
            "stepLabel": "25",
            "stepOrder": 25,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 105426
          },
          {
            "stepLabel": "26",
            "stepOrder": 26,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 107531
          },
          {
            "stepLabel": "27",
            "stepOrder": 27,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 109682
          },
          {
            "stepLabel": "28",
            "stepOrder": 28,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 111879
          },
          {
            "stepLabel": "29",
            "stepOrder": 29,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 114116
          },
          {
            "stepLabel": "30",
            "stepOrder": 30,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 116398
          },
          {
            "stepLabel": "31",
            "stepOrder": 31,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 118725
          },
          {
            "stepLabel": "32",
            "stepOrder": 32,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 121101
          },
          {
            "stepLabel": "33",
            "stepOrder": 33,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 123521
          },
          {
            "stepLabel": "34",
            "stepOrder": 34,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 125992
          },
          {
            "stepLabel": "35",
            "stepOrder": 35,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 128512
          }
        ]
      },
      {
        "id": 16,
        "scheduleName": "Psychologist/Speech Pathologist",
        "schoolYear": "2025-2026",
        "startYear": 2025,
        "scheduleType": "single_column",
        "laneLabels": null,
        "laneKind": null,
        "stepCount": 36,
        "laneCount": 1,
        "minSalary": 61531,
        "maxSalary": 140270,
        "sourceUrl": "https://example.org/joliet-cba-2025-2028.pdf",
        "pageStart": 42,
        "pageEnd": 45,
        "cells": [
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 61531
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 62729
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 63946
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 65185
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 67374
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 69558
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 71743
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 73925
          },
          {
            "stepLabel": "8",
            "stepOrder": 8,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 76108
          },
          {
            "stepLabel": "9",
            "stepOrder": 9,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 78289
          },
          {
            "stepLabel": "10",
            "stepOrder": 10,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 80476
          },
          {
            "stepLabel": "11",
            "stepOrder": 11,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 82658
          },
          {
            "stepLabel": "12",
            "stepOrder": 12,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 84880
          },
          {
            "stepLabel": "13",
            "stepOrder": 13,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 87257
          },
          {
            "stepLabel": "14",
            "stepOrder": 14,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 89699
          },
          {
            "stepLabel": "15",
            "stepOrder": 15,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 92215
          },
          {
            "stepLabel": "16",
            "stepOrder": 16,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 94791
          },
          {
            "stepLabel": "17",
            "stepOrder": 17,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 97449
          },
          {
            "stepLabel": "18",
            "stepOrder": 18,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 100175
          },
          {
            "stepLabel": "19",
            "stepOrder": 19,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 102179
          },
          {
            "stepLabel": "20",
            "stepOrder": 20,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 104223
          },
          {
            "stepLabel": "21",
            "stepOrder": 21,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 106307
          },
          {
            "stepLabel": "22",
            "stepOrder": 22,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 108433
          },
          {
            "stepLabel": "23",
            "stepOrder": 23,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 110602
          },
          {
            "stepLabel": "24",
            "stepOrder": 24,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 112814
          },
          {
            "stepLabel": "25",
            "stepOrder": 25,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 115070
          },
          {
            "stepLabel": "26",
            "stepOrder": 26,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 117371
          },
          {
            "stepLabel": "27",
            "stepOrder": 27,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 119719
          },
          {
            "stepLabel": "28",
            "stepOrder": 28,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 122113
          },
          {
            "stepLabel": "29",
            "stepOrder": 29,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 124556
          },
          {
            "stepLabel": "30",
            "stepOrder": 30,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 127046
          },
          {
            "stepLabel": "31",
            "stepOrder": 31,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 129588
          },
          {
            "stepLabel": "32",
            "stepOrder": 32,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 132179
          },
          {
            "stepLabel": "33",
            "stepOrder": 33,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 134823
          },
          {
            "stepLabel": "34",
            "stepOrder": 34,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 137519
          },
          {
            "stepLabel": "35",
            "stepOrder": 35,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 140270
          }
        ]
      },
      {
        "id": 17,
        "scheduleName": "Psychologist/Speech Pathologist",
        "schoolYear": "2026-2027",
        "startYear": 2026,
        "scheduleType": "single_column",
        "laneLabels": null,
        "laneKind": null,
        "stepCount": 36,
        "laneCount": 1,
        "minSalary": 62503,
        "maxSalary": 142485,
        "sourceUrl": "https://example.org/joliet-cba-2025-2028.pdf",
        "pageStart": 42,
        "pageEnd": 45,
        "cells": [
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 62503
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 63719
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 64956
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 66214
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 68438
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 70656
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 72876
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 75092
          },
          {
            "stepLabel": "8",
            "stepOrder": 8,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 77310
          },
          {
            "stepLabel": "9",
            "stepOrder": 9,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 79525
          },
          {
            "stepLabel": "10",
            "stepOrder": 10,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 81747
          },
          {
            "stepLabel": "11",
            "stepOrder": 11,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 83963
          },
          {
            "stepLabel": "12",
            "stepOrder": 12,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 86220
          },
          {
            "stepLabel": "13",
            "stepOrder": 13,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 88635
          },
          {
            "stepLabel": "14",
            "stepOrder": 14,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 91115
          },
          {
            "stepLabel": "15",
            "stepOrder": 15,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 93671
          },
          {
            "stepLabel": "16",
            "stepOrder": 16,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 96288
          },
          {
            "stepLabel": "17",
            "stepOrder": 17,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 98988
          },
          {
            "stepLabel": "18",
            "stepOrder": 18,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 101757
          },
          {
            "stepLabel": "19",
            "stepOrder": 19,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 103792
          },
          {
            "stepLabel": "20",
            "stepOrder": 20,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 105869
          },
          {
            "stepLabel": "21",
            "stepOrder": 21,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 107986
          },
          {
            "stepLabel": "22",
            "stepOrder": 22,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 110145
          },
          {
            "stepLabel": "23",
            "stepOrder": 23,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 112348
          },
          {
            "stepLabel": "24",
            "stepOrder": 24,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 114595
          },
          {
            "stepLabel": "25",
            "stepOrder": 25,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 116887
          },
          {
            "stepLabel": "26",
            "stepOrder": 26,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 119224
          },
          {
            "stepLabel": "27",
            "stepOrder": 27,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 121609
          },
          {
            "stepLabel": "28",
            "stepOrder": 28,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 124041
          },
          {
            "stepLabel": "29",
            "stepOrder": 29,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 126523
          },
          {
            "stepLabel": "30",
            "stepOrder": 30,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 129052
          },
          {
            "stepLabel": "31",
            "stepOrder": 31,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 131634
          },
          {
            "stepLabel": "32",
            "stepOrder": 32,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 134266
          },
          {
            "stepLabel": "33",
            "stepOrder": 33,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 136952
          },
          {
            "stepLabel": "34",
            "stepOrder": 34,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 139690
          },
          {
            "stepLabel": "35",
            "stepOrder": 35,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 142485
          }
        ]
      },
      {
        "id": 18,
        "scheduleName": "Psychologist/Speech Pathologist",
        "schoolYear": "2027-2028",
        "startYear": 2027,
        "scheduleType": "single_column",
        "laneLabels": null,
        "laneKind": null,
        "stepCount": 36,
        "laneCount": 1,
        "minSalary": 63185,
        "maxSalary": 144039,
        "sourceUrl": "https://example.org/joliet-cba-2025-2028.pdf",
        "pageStart": 42,
        "pageEnd": 45,
        "cells": [
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 63185
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 64414
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 65664
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 66936
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 69184
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 71427
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 73671
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 75911
          },
          {
            "stepLabel": "8",
            "stepOrder": 8,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 78153
          },
          {
            "stepLabel": "9",
            "stepOrder": 9,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 80392
          },
          {
            "stepLabel": "10",
            "stepOrder": 10,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 82639
          },
          {
            "stepLabel": "11",
            "stepOrder": 11,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 84879
          },
          {
            "stepLabel": "12",
            "stepOrder": 12,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 87160
          },
          {
            "stepLabel": "13",
            "stepOrder": 13,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 89602
          },
          {
            "stepLabel": "14",
            "stepOrder": 14,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 92109
          },
          {
            "stepLabel": "15",
            "stepOrder": 15,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 94693
          },
          {
            "stepLabel": "16",
            "stepOrder": 16,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 97338
          },
          {
            "stepLabel": "17",
            "stepOrder": 17,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 100068
          },
          {
            "stepLabel": "18",
            "stepOrder": 18,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 102867
          },
          {
            "stepLabel": "19",
            "stepOrder": 19,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 104924
          },
          {
            "stepLabel": "20",
            "stepOrder": 20,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 107024
          },
          {
            "stepLabel": "21",
            "stepOrder": 21,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 109164
          },
          {
            "stepLabel": "22",
            "stepOrder": 22,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 111346
          },
          {
            "stepLabel": "23",
            "stepOrder": 23,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 113573
          },
          {
            "stepLabel": "24",
            "stepOrder": 24,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 115845
          },
          {
            "stepLabel": "25",
            "stepOrder": 25,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 118162
          },
          {
            "stepLabel": "26",
            "stepOrder": 26,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 120524
          },
          {
            "stepLabel": "27",
            "stepOrder": 27,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 122935
          },
          {
            "stepLabel": "28",
            "stepOrder": 28,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 125394
          },
          {
            "stepLabel": "29",
            "stepOrder": 29,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 127903
          },
          {
            "stepLabel": "30",
            "stepOrder": 30,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 130459
          },
          {
            "stepLabel": "31",
            "stepOrder": 31,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 133070
          },
          {
            "stepLabel": "32",
            "stepOrder": 32,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 135730
          },
          {
            "stepLabel": "33",
            "stepOrder": 33,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 138446
          },
          {
            "stepLabel": "34",
            "stepOrder": 34,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 141213
          },
          {
            "stepLabel": "35",
            "stepOrder": 35,
            "laneLabel": null,
            "laneOrder": 0,
            "salary": 144039
          }
        ]
      },
      {
        "id": 10,
        "scheduleName": "Teachers",
        "schoolYear": "2025-2026",
        "startYear": 2025,
        "scheduleType": "lane_grid",
        "laneLabels": [
          "BA",
          "BA+15",
          "MA or 36",
          "MA+30"
        ],
        "laneKind": "education",
        "stepCount": 36,
        "laneCount": 4,
        "minSalary": 51676,
        "maxSalary": 123765,
        "sourceUrl": "https://example.org/joliet-cba-2025-2028.pdf",
        "pageStart": 42,
        "pageEnd": 45,
        "cells": [
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 51676
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 54838
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 56997
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 59171
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 52822
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 56058
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 58266
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 60486
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 53970
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 57277
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 59535
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 61802
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 55117
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 58495
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 60802
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 63116
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 56264
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 59715
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 62072
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 64430
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 57415
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 60936
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 63336
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 65747
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 58562
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 62155
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 64602
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 67063
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 59710
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 63371
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 65873
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 68378
          },
          {
            "stepLabel": "8",
            "stepOrder": 8,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 60860
          },
          {
            "stepLabel": "8",
            "stepOrder": 8,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 64591
          },
          {
            "stepLabel": "8",
            "stepOrder": 8,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 67142
          },
          {
            "stepLabel": "8",
            "stepOrder": 8,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 69692
          },
          {
            "stepLabel": "9",
            "stepOrder": 9,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 62016
          },
          {
            "stepLabel": "9",
            "stepOrder": 9,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 65818
          },
          {
            "stepLabel": "9",
            "stepOrder": 9,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 68419
          },
          {
            "stepLabel": "9",
            "stepOrder": 9,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 71022
          },
          {
            "stepLabel": "10",
            "stepOrder": 10,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 63151
          },
          {
            "stepLabel": "10",
            "stepOrder": 10,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 66894
          },
          {
            "stepLabel": "10",
            "stepOrder": 10,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 69571
          },
          {
            "stepLabel": "10",
            "stepOrder": 10,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 72245
          },
          {
            "stepLabel": "11",
            "stepOrder": 11,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 68287
          },
          {
            "stepLabel": "11",
            "stepOrder": 11,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 71067
          },
          {
            "stepLabel": "11",
            "stepOrder": 11,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 73852
          },
          {
            "stepLabel": "12",
            "stepOrder": 12,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 69678
          },
          {
            "stepLabel": "12",
            "stepOrder": 12,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 72566
          },
          {
            "stepLabel": "12",
            "stepOrder": 12,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 75455
          },
          {
            "stepLabel": "13",
            "stepOrder": 13,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 71067
          },
          {
            "stepLabel": "13",
            "stepOrder": 13,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 74068
          },
          {
            "stepLabel": "13",
            "stepOrder": 13,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 77063
          },
          {
            "stepLabel": "14",
            "stepOrder": 14,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 72461
          },
          {
            "stepLabel": "14",
            "stepOrder": 14,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 75566
          },
          {
            "stepLabel": "14",
            "stepOrder": 14,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 78670
          },
          {
            "stepLabel": "15",
            "stepOrder": 15,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 73852
          },
          {
            "stepLabel": "15",
            "stepOrder": 15,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 77063
          },
          {
            "stepLabel": "15",
            "stepOrder": 15,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 80275
          },
          {
            "stepLabel": "16",
            "stepOrder": 16,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 79097
          },
          {
            "stepLabel": "16",
            "stepOrder": 16,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 82416
          },
          {
            "stepLabel": "17",
            "stepOrder": 17,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 81130
          },
          {
            "stepLabel": "17",
            "stepOrder": 17,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 84554
          },
          {
            "stepLabel": "18",
            "stepOrder": 18,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 83162
          },
          {
            "stepLabel": "18",
            "stepOrder": 18,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 86694
          },
          {
            "stepLabel": "19",
            "stepOrder": 19,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 85197
          },
          {
            "stepLabel": "19",
            "stepOrder": 19,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 88836
          },
          {
            "stepLabel": "20",
            "stepOrder": 20,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 87232
          },
          {
            "stepLabel": "20",
            "stepOrder": 20,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 90977
          },
          {
            "stepLabel": "21",
            "stepOrder": 21,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 89264
          },
          {
            "stepLabel": "21",
            "stepOrder": 21,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 93116
          },
          {
            "stepLabel": "22",
            "stepOrder": 22,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 91298
          },
          {
            "stepLabel": "22",
            "stepOrder": 22,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 95258
          },
          {
            "stepLabel": "23",
            "stepOrder": 23,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 93331
          },
          {
            "stepLabel": "23",
            "stepOrder": 23,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 97399
          },
          {
            "stepLabel": "24",
            "stepOrder": 24,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 95365
          },
          {
            "stepLabel": "24",
            "stepOrder": 24,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 99539
          },
          {
            "stepLabel": "25",
            "stepOrder": 25,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 97273
          },
          {
            "stepLabel": "25",
            "stepOrder": 25,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 101530
          },
          {
            "stepLabel": "26",
            "stepOrder": 26,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 99219
          },
          {
            "stepLabel": "26",
            "stepOrder": 26,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 103560
          },
          {
            "stepLabel": "27",
            "stepOrder": 27,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 101201
          },
          {
            "stepLabel": "27",
            "stepOrder": 27,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 105631
          },
          {
            "stepLabel": "28",
            "stepOrder": 28,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 103226
          },
          {
            "stepLabel": "28",
            "stepOrder": 28,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 107746
          },
          {
            "stepLabel": "29",
            "stepOrder": 29,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 105290
          },
          {
            "stepLabel": "29",
            "stepOrder": 29,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 109901
          },
          {
            "stepLabel": "30",
            "stepOrder": 30,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 107397
          },
          {
            "stepLabel": "30",
            "stepOrder": 30,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 112098
          },
          {
            "stepLabel": "31",
            "stepOrder": 31,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 109544
          },
          {
            "stepLabel": "31",
            "stepOrder": 31,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 114340
          },
          {
            "stepLabel": "32",
            "stepOrder": 32,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 111735
          },
          {
            "stepLabel": "32",
            "stepOrder": 32,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 116627
          },
          {
            "stepLabel": "33",
            "stepOrder": 33,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 113970
          },
          {
            "stepLabel": "33",
            "stepOrder": 33,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 118959
          },
          {
            "stepLabel": "34",
            "stepOrder": 34,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 116250
          },
          {
            "stepLabel": "34",
            "stepOrder": 34,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 121338
          },
          {
            "stepLabel": "35",
            "stepOrder": 35,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 118574
          },
          {
            "stepLabel": "35",
            "stepOrder": 35,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 123765
          }
        ]
      },
      {
        "id": 11,
        "scheduleName": "Teachers",
        "schoolYear": "2026-2027",
        "startYear": 2026,
        "scheduleType": "lane_grid",
        "laneLabels": [
          "BA",
          "BA+15",
          "MA or 36",
          "MA+30"
        ],
        "laneKind": "education",
        "stepCount": 36,
        "laneCount": 4,
        "minSalary": 52658,
        "maxSalary": 126117,
        "sourceUrl": "https://example.org/joliet-cba-2025-2028.pdf",
        "pageStart": 42,
        "pageEnd": 45,
        "cells": [
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 52658
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 55880
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 58080
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 60295
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 53826
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 57123
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 59373
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 61635
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 54995
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 58365
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 60666
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 62976
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 56164
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 59606
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 61957
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 64315
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 57333
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 60850
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 63251
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 65654
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 58506
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 62094
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 64539
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 66996
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 59675
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 63336
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 65829
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 68337
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 60844
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 64575
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 67125
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 69677
          },
          {
            "stepLabel": "8",
            "stepOrder": 8,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 62016
          },
          {
            "stepLabel": "8",
            "stepOrder": 8,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 65818
          },
          {
            "stepLabel": "8",
            "stepOrder": 8,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 68418
          },
          {
            "stepLabel": "8",
            "stepOrder": 8,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 71016
          },
          {
            "stepLabel": "9",
            "stepOrder": 9,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 63194
          },
          {
            "stepLabel": "9",
            "stepOrder": 9,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 67069
          },
          {
            "stepLabel": "9",
            "stepOrder": 9,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 69719
          },
          {
            "stepLabel": "9",
            "stepOrder": 9,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 72371
          },
          {
            "stepLabel": "10",
            "stepOrder": 10,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 64351
          },
          {
            "stepLabel": "10",
            "stepOrder": 10,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 68165
          },
          {
            "stepLabel": "10",
            "stepOrder": 10,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 70893
          },
          {
            "stepLabel": "10",
            "stepOrder": 10,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 73618
          },
          {
            "stepLabel": "11",
            "stepOrder": 11,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 69584
          },
          {
            "stepLabel": "11",
            "stepOrder": 11,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 72417
          },
          {
            "stepLabel": "11",
            "stepOrder": 11,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 75255
          },
          {
            "stepLabel": "12",
            "stepOrder": 12,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 71002
          },
          {
            "stepLabel": "12",
            "stepOrder": 12,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 73945
          },
          {
            "stepLabel": "12",
            "stepOrder": 12,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 76889
          },
          {
            "stepLabel": "13",
            "stepOrder": 13,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 72417
          },
          {
            "stepLabel": "13",
            "stepOrder": 13,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 75475
          },
          {
            "stepLabel": "13",
            "stepOrder": 13,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 78527
          },
          {
            "stepLabel": "14",
            "stepOrder": 14,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 73838
          },
          {
            "stepLabel": "14",
            "stepOrder": 14,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 77002
          },
          {
            "stepLabel": "14",
            "stepOrder": 14,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 80165
          },
          {
            "stepLabel": "15",
            "stepOrder": 15,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 75255
          },
          {
            "stepLabel": "15",
            "stepOrder": 15,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 78527
          },
          {
            "stepLabel": "15",
            "stepOrder": 15,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 81800
          },
          {
            "stepLabel": "16",
            "stepOrder": 16,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 80600
          },
          {
            "stepLabel": "16",
            "stepOrder": 16,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 83982
          },
          {
            "stepLabel": "17",
            "stepOrder": 17,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 82671
          },
          {
            "stepLabel": "17",
            "stepOrder": 17,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 86161
          },
          {
            "stepLabel": "18",
            "stepOrder": 18,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 84742
          },
          {
            "stepLabel": "18",
            "stepOrder": 18,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 88341
          },
          {
            "stepLabel": "19",
            "stepOrder": 19,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 86816
          },
          {
            "stepLabel": "19",
            "stepOrder": 19,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 90524
          },
          {
            "stepLabel": "20",
            "stepOrder": 20,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 88889
          },
          {
            "stepLabel": "20",
            "stepOrder": 20,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 92706
          },
          {
            "stepLabel": "21",
            "stepOrder": 21,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 90960
          },
          {
            "stepLabel": "21",
            "stepOrder": 21,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 94885
          },
          {
            "stepLabel": "22",
            "stepOrder": 22,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 93033
          },
          {
            "stepLabel": "22",
            "stepOrder": 22,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 97068
          },
          {
            "stepLabel": "23",
            "stepOrder": 23,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 95104
          },
          {
            "stepLabel": "23",
            "stepOrder": 23,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 99250
          },
          {
            "stepLabel": "24",
            "stepOrder": 24,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 97177
          },
          {
            "stepLabel": "24",
            "stepOrder": 24,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 101430
          },
          {
            "stepLabel": "25",
            "stepOrder": 25,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 99121
          },
          {
            "stepLabel": "25",
            "stepOrder": 25,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 103459
          },
          {
            "stepLabel": "26",
            "stepOrder": 26,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 101104
          },
          {
            "stepLabel": "26",
            "stepOrder": 26,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 105528
          },
          {
            "stepLabel": "27",
            "stepOrder": 27,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 103124
          },
          {
            "stepLabel": "27",
            "stepOrder": 27,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 107638
          },
          {
            "stepLabel": "28",
            "stepOrder": 28,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 105187
          },
          {
            "stepLabel": "28",
            "stepOrder": 28,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 109793
          },
          {
            "stepLabel": "29",
            "stepOrder": 29,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 107291
          },
          {
            "stepLabel": "29",
            "stepOrder": 29,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 111989
          },
          {
            "stepLabel": "30",
            "stepOrder": 30,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 109438
          },
          {
            "stepLabel": "30",
            "stepOrder": 30,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 114228
          },
          {
            "stepLabel": "31",
            "stepOrder": 31,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 111625
          },
          {
            "stepLabel": "31",
            "stepOrder": 31,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 116512
          },
          {
            "stepLabel": "32",
            "stepOrder": 32,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 113858
          },
          {
            "stepLabel": "32",
            "stepOrder": 32,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 118843
          },
          {
            "stepLabel": "33",
            "stepOrder": 33,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 116135
          },
          {
            "stepLabel": "33",
            "stepOrder": 33,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 121219
          },
          {
            "stepLabel": "34",
            "stepOrder": 34,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 118459
          },
          {
            "stepLabel": "34",
            "stepOrder": 34,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 123643
          },
          {
            "stepLabel": "35",
            "stepOrder": 35,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 120827
          },
          {
            "stepLabel": "35",
            "stepOrder": 35,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 126117
          }
        ]
      },
      {
        "id": 12,
        "scheduleName": "Teachers",
        "schoolYear": "2027-2028",
        "startYear": 2027,
        "scheduleType": "lane_grid",
        "laneLabels": [
          "BA",
          "BA+15",
          "MA or 36",
          "MA+30"
        ],
        "laneKind": "education",
        "stepCount": 36,
        "laneCount": 4,
        "minSalary": 53422,
        "maxSalary": 127946,
        "sourceUrl": "https://example.org/joliet-cba-2025-2028.pdf",
        "pageStart": 42,
        "pageEnd": 45,
        "cells": [
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 53422
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 56690
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 58922
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 61169
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 54606
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 57951
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 60234
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 62529
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 55792
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 59211
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 61546
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 63889
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 56978
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 60470
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 62855
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 65248
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 58164
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 61732
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 64168
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 66606
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 59354
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 62994
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 65475
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 67967
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 60540
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 64254
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 66784
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 69328
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 61726
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 65511
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 68098
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 70687
          },
          {
            "stepLabel": "8",
            "stepOrder": 8,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 62915
          },
          {
            "stepLabel": "8",
            "stepOrder": 8,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 66772
          },
          {
            "stepLabel": "8",
            "stepOrder": 8,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 69410
          },
          {
            "stepLabel": "8",
            "stepOrder": 8,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 72046
          },
          {
            "stepLabel": "9",
            "stepOrder": 9,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 64110
          },
          {
            "stepLabel": "9",
            "stepOrder": 9,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 68042
          },
          {
            "stepLabel": "9",
            "stepOrder": 9,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 70730
          },
          {
            "stepLabel": "9",
            "stepOrder": 9,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 73420
          },
          {
            "stepLabel": "10",
            "stepOrder": 10,
            "laneLabel": "BA",
            "laneOrder": 0,
            "salary": 65284
          },
          {
            "stepLabel": "10",
            "stepOrder": 10,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 69153
          },
          {
            "stepLabel": "10",
            "stepOrder": 10,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 71921
          },
          {
            "stepLabel": "10",
            "stepOrder": 10,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 74685
          },
          {
            "stepLabel": "11",
            "stepOrder": 11,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 70593
          },
          {
            "stepLabel": "11",
            "stepOrder": 11,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 73467
          },
          {
            "stepLabel": "11",
            "stepOrder": 11,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 76346
          },
          {
            "stepLabel": "12",
            "stepOrder": 12,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 72032
          },
          {
            "stepLabel": "12",
            "stepOrder": 12,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 75017
          },
          {
            "stepLabel": "12",
            "stepOrder": 12,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 78004
          },
          {
            "stepLabel": "13",
            "stepOrder": 13,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 73467
          },
          {
            "stepLabel": "13",
            "stepOrder": 13,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 76569
          },
          {
            "stepLabel": "13",
            "stepOrder": 13,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 79666
          },
          {
            "stepLabel": "14",
            "stepOrder": 14,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 74909
          },
          {
            "stepLabel": "14",
            "stepOrder": 14,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 78119
          },
          {
            "stepLabel": "14",
            "stepOrder": 14,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 81327
          },
          {
            "stepLabel": "15",
            "stepOrder": 15,
            "laneLabel": "BA+15",
            "laneOrder": 1,
            "salary": 76346
          },
          {
            "stepLabel": "15",
            "stepOrder": 15,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 79666
          },
          {
            "stepLabel": "15",
            "stepOrder": 15,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 82986
          },
          {
            "stepLabel": "16",
            "stepOrder": 16,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 81769
          },
          {
            "stepLabel": "16",
            "stepOrder": 16,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 85200
          },
          {
            "stepLabel": "17",
            "stepOrder": 17,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 83870
          },
          {
            "stepLabel": "17",
            "stepOrder": 17,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 87410
          },
          {
            "stepLabel": "18",
            "stepOrder": 18,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 85971
          },
          {
            "stepLabel": "18",
            "stepOrder": 18,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 89622
          },
          {
            "stepLabel": "19",
            "stepOrder": 19,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 88075
          },
          {
            "stepLabel": "19",
            "stepOrder": 19,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 91837
          },
          {
            "stepLabel": "20",
            "stepOrder": 20,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 90178
          },
          {
            "stepLabel": "20",
            "stepOrder": 20,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 94050
          },
          {
            "stepLabel": "21",
            "stepOrder": 21,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 92279
          },
          {
            "stepLabel": "21",
            "stepOrder": 21,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 96261
          },
          {
            "stepLabel": "22",
            "stepOrder": 22,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 94382
          },
          {
            "stepLabel": "22",
            "stepOrder": 22,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 98475
          },
          {
            "stepLabel": "23",
            "stepOrder": 23,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 96483
          },
          {
            "stepLabel": "23",
            "stepOrder": 23,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 100689
          },
          {
            "stepLabel": "24",
            "stepOrder": 24,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 98586
          },
          {
            "stepLabel": "24",
            "stepOrder": 24,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 102901
          },
          {
            "stepLabel": "25",
            "stepOrder": 25,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 100558
          },
          {
            "stepLabel": "25",
            "stepOrder": 25,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 104959
          },
          {
            "stepLabel": "26",
            "stepOrder": 26,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 102570
          },
          {
            "stepLabel": "26",
            "stepOrder": 26,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 107058
          },
          {
            "stepLabel": "27",
            "stepOrder": 27,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 104619
          },
          {
            "stepLabel": "27",
            "stepOrder": 27,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 109199
          },
          {
            "stepLabel": "28",
            "stepOrder": 28,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 106712
          },
          {
            "stepLabel": "28",
            "stepOrder": 28,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 111385
          },
          {
            "stepLabel": "29",
            "stepOrder": 29,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 108847
          },
          {
            "stepLabel": "29",
            "stepOrder": 29,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 113613
          },
          {
            "stepLabel": "30",
            "stepOrder": 30,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 111025
          },
          {
            "stepLabel": "30",
            "stepOrder": 30,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 115884
          },
          {
            "stepLabel": "31",
            "stepOrder": 31,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 113244
          },
          {
            "stepLabel": "31",
            "stepOrder": 31,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 118201
          },
          {
            "stepLabel": "32",
            "stepOrder": 32,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 115509
          },
          {
            "stepLabel": "32",
            "stepOrder": 32,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 120566
          },
          {
            "stepLabel": "33",
            "stepOrder": 33,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 117819
          },
          {
            "stepLabel": "33",
            "stepOrder": 33,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 122977
          },
          {
            "stepLabel": "34",
            "stepOrder": 34,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 120177
          },
          {
            "stepLabel": "34",
            "stepOrder": 34,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 125436
          },
          {
            "stepLabel": "35",
            "stepOrder": 35,
            "laneLabel": "MA or 36",
            "laneOrder": 2,
            "salary": 122579
          },
          {
            "stepLabel": "35",
            "stepOrder": 35,
            "laneLabel": "MA+30",
            "laneOrder": 3,
            "salary": 127946
          }
        ]
      }
    ],
    "jobFamilies": [
      "Counselors/Social Workers",
      "Psychologist/Speech Pathologist",
      "Teachers"
    ],
    "schoolYears": [
      "2025-2026",
      "2026-2027",
      "2027-2028"
    ],
    "summary": {
      "scheduleName": "Teachers",
      "schoolYear": "2027-2028",
      "baseSalary": 53422,
      "maBaseSalary": 58922,
      "maxSalary": 127946
    },
    "availableUnits": [
      "teachers",
      "custodial"
    ]
  },
  "custodial": {
    "bargainingUnit": "custodial",
    "contractId": 662,
    "schedules": [
      {
        "id": 9000,
        "scheduleName": "Custodial & Maintenance",
        "schoolYear": "2025-2026",
        "startYear": 2025,
        "scheduleType": "lane_grid",
        "laneLabels": [
          "Custodian",
          "Groundskeeper",
          "Maintenance",
          "Engineer B",
          "Engineer A"
        ],
        "laneKind": "columns",
        "stepCount": 8,
        "laneCount": 5,
        "minSalary": 38480,
        "maxSalary": 69656,
        "sourceUrl": "https://example.org/joliet-custodial-cba-2025-2028.pdf",
        "pageStart": 18,
        "pageEnd": 19,
        "cells": [
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 38480
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 41080
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 46280
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 52000
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 58240
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 39556
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 42232
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 47576
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 53456
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 59872
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 40636
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 43380
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 48872
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 54912
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 61500
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 41712
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 44532
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 50168
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 56368
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 63132
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 42788
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 45680
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 51464
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 57824
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 64764
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 43868
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 46832
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 52760
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 59280
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 66392
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 44944
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 47980
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 54056
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 60736
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 68024
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 46024
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 49132
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 55352
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 62192
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 69656
          }
        ]
      },
      {
        "id": 9001,
        "scheduleName": "Custodial & Maintenance",
        "schoolYear": "2026-2027",
        "startYear": 2026,
        "scheduleType": "lane_grid",
        "laneLabels": [
          "Custodian",
          "Groundskeeper",
          "Maintenance",
          "Engineer B",
          "Engineer A"
        ],
        "laneKind": "columns",
        "stepCount": 8,
        "laneCount": 5,
        "minSalary": 39444,
        "maxSalary": 71396,
        "sourceUrl": "https://example.org/joliet-custodial-cba-2025-2028.pdf",
        "pageStart": 18,
        "pageEnd": 19,
        "cells": [
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 39444
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 42108
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 47436
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 53300
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 59696
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 40548
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 43284
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 48764
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 54792
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 61368
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 41652
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 44464
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 50092
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 56284
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 63040
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 42756
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 45644
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 51420
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 57776
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 64712
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 43860
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 46824
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 52748
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 59268
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 66380
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 44964
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 48000
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 54080
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 60764
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 68052
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 46068
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 49180
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 55408
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 62256
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 69724
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 47172
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 50360
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 56736
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 63748
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 71396
          }
        ]
      },
      {
        "id": 9002,
        "scheduleName": "Custodial & Maintenance",
        "schoolYear": "2027-2028",
        "startYear": 2027,
        "scheduleType": "lane_grid",
        "laneLabels": [
          "Custodian",
          "Groundskeeper",
          "Maintenance",
          "Engineer B",
          "Engineer A"
        ],
        "laneKind": "columns",
        "stepCount": 8,
        "laneCount": 5,
        "minSalary": 40428,
        "maxSalary": 73180,
        "sourceUrl": "https://example.org/joliet-custodial-cba-2025-2028.pdf",
        "pageStart": 18,
        "pageEnd": 19,
        "cells": [
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 40428
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 43160
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 48624
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 54632
          },
          {
            "stepLabel": "0",
            "stepOrder": 0,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 61188
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 41560
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 44368
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 49984
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 56164
          },
          {
            "stepLabel": "1",
            "stepOrder": 1,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 62900
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 42692
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 45576
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 51344
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 57692
          },
          {
            "stepLabel": "2",
            "stepOrder": 2,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 64616
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 43824
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 46784
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 52708
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 59220
          },
          {
            "stepLabel": "3",
            "stepOrder": 3,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 66328
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 44956
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 47992
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 54068
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 60752
          },
          {
            "stepLabel": "4",
            "stepOrder": 4,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 68040
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 46088
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 49204
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 55432
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 62280
          },
          {
            "stepLabel": "5",
            "stepOrder": 5,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 69756
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 47220
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 50412
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 56792
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 63812
          },
          {
            "stepLabel": "6",
            "stepOrder": 6,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 71468
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "Custodian",
            "laneOrder": 0,
            "salary": 48352
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "Groundskeeper",
            "laneOrder": 1,
            "salary": 51620
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "Maintenance",
            "laneOrder": 2,
            "salary": 58152
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "Engineer B",
            "laneOrder": 3,
            "salary": 65340
          },
          {
            "stepLabel": "7",
            "stepOrder": 7,
            "laneLabel": "Engineer A",
            "laneOrder": 4,
            "salary": 73180
          }
        ]
      }
    ],
    "jobFamilies": [
      "Custodial & Maintenance"
    ],
    "schoolYears": [
      "2025-2026",
      "2026-2027",
      "2027-2028"
    ],
    "summary": {
      "scheduleName": "Custodial & Maintenance",
      "schoolYear": "2027-2028",
      "baseSalary": 40428,
      "maBaseSalary": null,
      "maxSalary": 73180
    },
    "availableUnits": [
      "teachers",
      "custodial"
    ]
  }
};

  export function getSalarySchedules(unit: string): SalaryResponse {
    return SALARY_BY_UNIT[unit] ?? SALARY_BY_UNIT['teachers'];
  }
  