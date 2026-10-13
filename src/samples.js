// Synthetic sample documents for demos and tests. All names and values are fictional.
// Dates are generated relative to "today" so follow-up due dates are always meaningful.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ago(now, days) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const BANNER = 'SAMPLE DOCUMENT - fictional data for demonstration only';

export function buildSampleDocuments(now = new Date()) {
  const rx = ago(now, 21);
  const collected = ago(now, 20);
  const reported = ago(now, 19);
  const admitted = ago(now, 16);
  const discharged = ago(now, 12);

  const prescription = `${BANNER}

CITY CARE CLINIC
Outpatient Prescription
Dr. Anil Rao, MD (General Medicine)

Date: ${rx}
Patient: Sample Patient          Age/Sex: 58 / M

Rx
1. Tab. Metformin 500 mg - take twice daily after meals - for 30 days
2. Tab. Amlodipine 5 mg - take once daily in the morning - for 30 days
3. Tab. Atorvastatin 10 mg - take once daily at bedtime - continue

Advice
- Reduce salt and sugar intake.
- Review in 4 weeks with fasting blood sugar and HbA1c reports.`;

  const lab = `${BANNER}

LIFELINE DIAGNOSTICS
Laboratory Report
Sample collected: ${collected}          Reported: ${reported}
Referred by: Dr. A. Rao

Test                 Result    Unit      Reference range    Flag
Hemoglobin           13.8      g/dL      13.0 - 17.0
HbA1c                8.2       %         4.0 - 5.6          H
Fasting glucose      162       mg/dL     70 - 99            H
Creatinine           1.5       mg/dL     0.7 - 1.3          H
eGFR                 52        mL/min    > 60               L
LDL cholesterol      96        mg/dL     < 100
Potassium            4.6       mmol/L    3.5 - 5.1

Values marked H or L fall outside the reference range printed above.`;

  const discharge = [
    `${BANNER}

RIVERSIDE GENERAL HOSPITAL
Discharge Summary
Patient: Sample Patient          Age/Sex: 58 / M
Admitted: ${admitted}          Discharged: ${discharged}
Consultant: Dr. Meera Iyer

Reason for admission (as recorded): high blood sugar with dehydration.

Discharge medications
1. Tab. Metformin 500 mg - once daily after dinner
2. Tab. Amlodipine 5 mg - once daily
3. Tab. Pantoprazole 40 mg - once daily before breakfast - for 14 days`,
    `Hospital course
The patient was treated with intravenous fluids and monitored. Blood sugar readings improved during the stay.

Instructions at discharge
- Drink fluids regularly through the day.
- Avoid painkillers such as ibuprofen unless your doctor advises otherwise.
- Check blood sugar twice daily and keep a written log.
- Follow a diabetic diet as explained by the dietitian.`,
    `Follow-up
Review with Dr. Rao in 2 weeks.
Repeat kidney function test (serum creatinine) and HbA1c after 6 weeks.

Return to the emergency department if you have persistent vomiting, severe abdominal pain, confusion or chest pain.

Signed: Dr. Meera Iyer`,
  ];

  const doc = (id, name, pages) => ({
    id,
    name,
    origin: 'sample',
    unit: 'page',
    ocrConfidence: null,
    pages: pages.map((text, i) => ({ page: i + 1, text })),
  });

  return [
    doc('d1', 'Prescription - City Care Clinic', [prescription]),
    doc('d2', 'Lab report - Lifeline Diagnostics', [lab]),
    doc('d3', 'Discharge summary - Riverside Hospital', discharge),
  ];
}
