/**
 * Generates randomised tennis-club-membership declaration payloads.
 * Field names mirror those used in generate-data.ts (derived from the country config).
 *
 * No external libraries — uses only Math.random() so it works inside k6.
 */

// ─── Name pools ───────────────────────────────────────────────────────────────

const FIRST_NAMES = [
  'James',
  'Mary',
  'John',
  'Patricia',
  'Robert',
  'Jennifer',
  'Michael',
  'Linda',
  'William',
  'Barbara',
  'David',
  'Susan',
  'Richard',
  'Jessica',
  'Joseph',
  'Sarah',
  'Thomas',
  'Karen',
  'Charles',
  'Lisa',
  'Chanda',
  'Mweene',
  'Bwalya',
  'Mutale',
  'Naledi',
  'Thandiwe',
  'Sipho',
  'Nomsa',
  'Thabo',
  'Zanele'
]

const LAST_NAMES = [
  'Smith',
  'Johnson',
  'Williams',
  'Brown',
  'Jones',
  'Garcia',
  'Miller',
  'Davis',
  'Mwansa',
  'Phiri',
  'Banda',
  'Tembo',
  'Mulenga',
  'Chanda',
  'Kabwe',
  'Musonda',
  'Mutale',
  'Zulu',
  'Dlamini',
  'Khumalo'
]

const ROLES = [
  'Registrar',
  'Coach',
  'Club President',
  'Secretary',
  'Treasurer'
] as const
const DEVICES = ['Mobile phone', 'Tablet', 'Desktop computer'] as const
const HONORIFICS = ['Mr.', 'Mrs.', 'Ms.', 'Dr.'] as const
const DURATION_UNITS = ['Hours', 'Days', 'Minutes'] as const

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** Returns a date string (YYYY-MM-DD) for an age between min and max years. */
function randomDOB(minAge = 5, maxAge = 90): string {
  const now = new Date()
  const year = now.getFullYear() - randInt(minAge, maxAge)
  const month = String(randInt(1, 12)).padStart(2, '0')
  const day = String(randInt(1, 28)).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function randomTime(): string {
  return `${String(randInt(0, 23)).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}`
}

function randomId(): string {
  return String(randInt(1_000_000_000, 9_999_999_999))
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TennisClubDeclaration {
  'applicant.name': { firstname: string; middlename: string; surname: string }
  'applicant.dob': string
  'applicant.tob': string
  'applicant.registrationDuration': { unit: string; numericValue: number }
  // senior-pass page is shown when applicant is 60+ years old
  'senior-pass.id'?: string
  'recommender.name': { firstname: string; middlename: string; surname: string }
  'recommender.id': string
  'recommender.none': false
  'recommender.role': string
  'recommender.device': string
  'recommender.fullHonorificName': string
  'recommender2.id': string
}

// ─── Generator ────────────────────────────────────────────────────────────────

export function generateDeclaration(): TennisClubDeclaration {
  const firstName = pick(FIRST_NAMES)
  const surname = pick(LAST_NAMES)

  const recFirst = pick(FIRST_NAMES)
  const recSurname = pick(LAST_NAMES)
  const recRole = pick(ROLES)

  const dob = randomDOB(5, 90)

  // Mirror the server's conditional: senior-pass section is shown when DOB is
  // more than (365 * 60 + 15) days in the past.
  const seniorThreshold = new Date()
  seniorThreshold.setDate(seniorThreshold.getDate() - (365 * 60 + 15))
  const seniorPass: Pick<TennisClubDeclaration, 'senior-pass.id'> =
    new Date(dob) < seniorThreshold ? { 'senior-pass.id': randomId() } : {}

  return {
    'applicant.name': { firstname: firstName, middlename: '', surname },
    'applicant.dob': dob,
    'applicant.tob': randomTime(),
    'applicant.registrationDuration': {
      unit: pick(DURATION_UNITS),
      numericValue: randInt(1, 72)
    },
    'recommender.name': {
      firstname: recFirst,
      middlename: '',
      surname: recSurname
    },
    ...seniorPass,
    'recommender.id': randomId(),
    'recommender.none': false,
    'recommender.role': recRole,
    'recommender.device': pick(DEVICES),
    'recommender.fullHonorificName': `${pick(HONORIFICS)} ${recFirst} ${recSurname}`,
    'recommender2.id': randomId()
  }
}
