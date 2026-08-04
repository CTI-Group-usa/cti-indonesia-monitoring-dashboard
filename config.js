// ─────────────────────────────────────────────────────────────
//  CONFIGURATION — CTI Indonesia Monitoring Dashboard
//  Fill in the ⚠️ TODO values before deploying.
// ─────────────────────────────────────────────────────────────
const CONFIG = {

  // ── Cloudflare Worker proxy (dedicated to this project) ──────
  //   This worker holds the Zoho refresh token as a secret and
  //   proxies both Zoho Recruit and Zoho Sheet. See worker.js.
  //   ⚠️ TODO: after deploying the worker, paste its URL here.
  PROXY: 'https://cti-indo-proxy.putu-astra.workers.dev',

  // ─────────────────────────────────────────────────────────────
  //  ZOHO RECRUIT  — primary "pull" source
  // ─────────────────────────────────────────────────────────────
  //   Recruit module API name = "Candidates" (shown as "Seafarers").
  RECRUIT_MODULE: 'Candidates',

  //   Field API names — from the "Candidates" (Seafarers) module.
  //   Left side = the name used throughout the app (keep these).
  //   Right side = the exact Zoho Recruit API field name.
  //   `email` is the merge key joined against the Zoho Sheet.
  FIELDS: {
    // Identity
    firstName:        'First_Name',
    lastName:         'Last_Name',
    email:            'Email',                 // ← merge key against the Sheet
    mobile:           'Mobile',
    gender:           'Gender',
    dateOfBirth:      'Date_of_Birth',
    age:              'Ages',                  // Formula
    seafarerId:       'Candidate_ID',          // Auto Number ("Seafarer ID")
    crewIdNumber:     'Crew_ID_Number',        // "Seafarer ID Number" — joins Cruise sheet
    salutation:       'Salutation',
    maritalStatus:    'Marital_Status',

    // Location
    country:          'Country',
    city:             'City',
    state:            'State',                 // "Province"
    ctiOffice:        'CTI_Office',            // Pick List (e.g. Indonesia)
    origin:           'Origin',

    // Pipeline / status
    status:           'Candidate_Status',      // "Seafarer Status" — primary
    crewStatus:       'Crew_Status',
    crewMemberStatus: 'Crew_Member_Status',    // "Seafarers Status"
    employmentStatus: 'Employment_Status',
    onboardingStatus: 'Onboarding_Status',
    complianceNotes:  'Compliance_Notes',
    rescheduledDate:  'Rescheduled_Date',
    delayReason:      'Reasons_for_Delayed_Assignment_or_Resignation',

    // Role / placement
    department:       'Department',
    position:         'Position_Applied',      // "Position Hired"
    currentJobTitle:  'Current_Job_Title',
    cruiseLine:       'Cruise_Line',
    joiningShip:      'Joining_Ship',
    signOnDate:       'Sign_On_Date',
    signOffDate:      'Sign_Off_Date',
    signOnPort:       'Sign_On_Port',
    hiredDate:        'Hired_Date',
    contractNumber:   'Contract_Number',
    source:           'Source',

    // People
    owner:            'Candidate_Owner',       // Lookup
    recruiter:        'Client_Interviewer',    // "Recruiter"

    // Documents / readiness
    passportStatus:   'Passport_Status',
    passportNumber:   'Passport_Number',
    passportExpiry:   'Passport_Expired_Date',
    medicalStatus:    'Medical_Status',
    medicalExpiry:    'Medical_Expiration_Date',
    bstStatus:        'BST_Status',
    bstNumber:        'BST_Certificate_Number',
    bstExpiry:        'BST_Expiration_Date',
    seamanBookStatus: 'Seaman_Book_Status',
    seamanBookNumber: 'Seaman_Book_Number',
    seamanBookExpiry: 'Seaman_Book_Expiration_Date',
    vaccinesStatus:   'Vaccines_Status',       // "Completed Vaccination"

    // Per-visa-type fields (for the VISA page sub-tabs)
    c1dVisaStatus:       'C1_D_Visa_Status',
    c1dVisaNumber:       'C1_D_Visa_Number',
    c1dVisaAppointment:  'C1_D_Visa_Appointment_Date',
    c1dVisaExpiry:       'C1_D_Visa_Expiration_Date',
    mcvStatus:           'MCV_Status',
    mcvNumber:           'MCV_Number',
    mcvExpiry:           'MCV_Expiration_Date',
    mcvPassportNumber:   'MCV_s_Passport_Number',
    oktbStatus:          'OKTB',
    // Schengen is tracked via the "Other Visa" fields (Other Visa Name = Schengen)
    otherVisaStatus:     'Other_Visa_Status',
    otherVisaName:       'Other_Visa_Name',
    otherVisaNumber:     'Other_Visa_Number',
    otherVisaAppointment:'Other_Visa_Appointment_Date',
    otherVisaExpiry:     'Other_Visa_Expiration_Date',
    otherVisaIssuedDate: 'Other_Visa_Issued_Date',

    // "Expected ready" dates the admin records when a document isn't ready yet
    // (drives the Pending Action section).
    passportExpectedDate:   'Passport_Expected_Date',
    bstExpectedDate:        'BST_Expected_Date',
    seamanBookExpectedDate: 'Seaman_Book_Expected_Date',
    medicalExpectedDate:    'Medical_Expected_Date',
    c1dExpectedDate:        'C1_D_Visa_Expected_Date',
    otherVisaExpectedDate:  'Other_Visa_Expected_Date',
    mcvExpectedDate:        'MCV_Expected_Date',
    oktbRequestedDate:      'OKTB_Requested_Date',

    // Timestamps  (NOTE: Modified Time API name is Updated_On)
    createdDate:      'Created_Time',
    modifiedDate:     'Updated_On',
  },

  // ─────────────────────────────────────────────────────────────
  //  ZOHO SHEETS  — additional data sources, merged into each
  //  seafarer record. Each sheet's rows are joined to a Recruit
  //  record by matching `keyColumn` (in the sheet) against the
  //  record field named by `matchOn` (case-insensitive).
  // ─────────────────────────────────────────────────────────────
  SHEETS: [
    {
      key:        'visa',                       // internal id (keep unique)
      label:      'Visa Registration Log',
      resourceId: 'vpzkvba5ae0adfc1247a8b7383dbef6ea3d8d',
      worksheet:  'VISA APPLICATIONS',
      headerRow:  1,

      // Join: sheet's "Email Address" == record email.
      matchOn:    'email',
      keyColumn:  'Email Address',

      // app field  ->  exact Sheet column header text.
      columns: {
        visaType:        'Please select the type of visa you want to process',
        visaStatus:      'Visa Status',
        visaPayment:     'Payment Status',
        visaAppointment: 'Appointment Date',
        visaAppId:       'Visa Application ID',
        visaRegDate:     'Added Time',
      },
      // Columns editable from the dashboard (pushed back). [] = read-only.
      editable: [],
    },
    {
      key:        'cruise',
      label:      'Cruise Line Deployment Report',
      resourceId: 'begbjf0b04d7026534b328e36baa0a9d82df7',
      worksheet:  'Deployment',
      headerRow:  1,

      // Join: sheet's "Crew ID" == record crewIdNumber (Crew_ID_Number).
      // NOTE: this sheet is deployment HISTORY — a seafarer can appear many
      // times. Last matching row wins (see zoho.js). Ask if you want "latest
      // by Sign On Date" instead.
      matchOn:    'crewIdNumber',
      keyColumn:  'Crew ID',

      columns: {
        deployCruiseLine: 'Cruise Line',
        deployShip:       'Joining Ship',
        deployStatus:     'Onboarding Status',
        deployDate:       'Sign On Date',
        deployPosition:   'Position Hired',
        deployPort:       'Sign On Port',
        deployEmployment: 'Employment Status',
      },
      editable: [],
    },
  ],

  // ─────────────────────────────────────────────────────────────
  //  Local dashboard users (SHA-256 hashed passwords)
  // ─────────────────────────────────────────────────────────────
  //   Generate a hash in the browser console:
  //   crypto.subtle.digest('SHA-256', new TextEncoder().encode('yourpassword'))
  //     .then(b => console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))
  USERS: {
    // Passwords updated 2026-07-21 per user request.
    // To change: hash a new password with the snippet above and replace.
    admin: { hash: '3b612c75a7b5048a435fb6ec81e52ff92d6d795a8b5a9c17070f6a63c97a53b2', role: 'admin' },
    staff: { hash: 'cdc4d189f8469bf67d5c5d2137221b8712e04c29415bb67df0b7e8d347694ef2', role: 'staff' },
  },

  // ── Branding ─────────────────────────────────────────────────
  APP_NAME:     'Indonesia Monitoring',
  ORG_NAME:     'CTI Group Worldwide Services, Inc.',
  ACCENT_COLOR: '#B01A18',
};
