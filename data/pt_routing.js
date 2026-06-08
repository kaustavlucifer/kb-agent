export const PT_RELATED = {
  'Industry-OmniStudio': [
    'Revenue Cloud (Core)-OmniStudio',
    'Industry-Document Generation',
    'Revenue-Document Generation'
  ],
  'Revenue Cloud (Core)-OmniStudio': [
    'Industry-OmniStudio',
    'Industry-Document Generation',
    'Revenue-Document Generation'
  ],
  'Industry-Document Generation': [
    'Revenue-Document Generation',
    'Industry-OmniStudio',
    'Revenue Cloud (Core)-OmniStudio'
  ],
  'Revenue-Document Generation': [
    'Industry-Document Generation',
    'Industry-OmniStudio',
    'Revenue Cloud (Core)-OmniStudio'
  ],
  'Industry-Health Cloud': [
    'Industry-Health & Insurance',
    'Industry-Life Sciences',
    'Industry-OmniStudio'
  ],
  'Industry-Health & Insurance': [
    'Industry-Health Cloud',
    'Industry-OmniStudio'
  ],
  'Industry-Life Sciences': [
    'Industry-Health Cloud'
  ],
  'Industry-Financial Services': [
    'Industry-OmniStudio'
  ],
  'Industry-Communication Cloud': [
    'Industry-OmniStudio',
    'Industry-CPQ / Order Management / Digital Commerce'
  ],
  'Industry-CPQ / Order Management / Digital Commerce': [
    'Industry-Communication Cloud',
    'Industry-OmniStudio'
  ],
  'Industry-Retail and Consumer Goods': [
    'Industry-OmniStudio'
  ],
  'Industry-Energy & Utilities Cloud': [
    'Industry-OmniStudio',
    'Industry-CPQ / Order Management / Digital Commerce'
  ],
  'Industry-Business Rules Engine (BRE)': [
    'Revenue Cloud (Core)-Business Rules Engine',
    'Industry-OmniStudio'
  ],
  'Revenue Cloud (Core)-Business Rules Engine': [
    'Industry-Business Rules Engine (BRE)',
    'Revenue Cloud (Core)-Configurator',
    'Revenue Cloud (Core)-Price Management'
  ],
  'Revenue Cloud (Core)-Billing & Invoicing': [
    'Revenue Cloud (Core)-Transaction Management',
    'Revenue Cloud (Core)-Usage & Ratings'
  ],
  'Revenue Cloud (Core)-Configurator': [
    'Revenue Cloud (Core)-Product Catalog Management',
    'Revenue Cloud (Core)-Business Rules Engine',
    'Revenue Cloud (Core)-Price Management'
  ],
  'Revenue Cloud (Core)-Contract Lifecycle Management with DocGen': [
    'Industry-Document Generation',
    'Revenue-Document Generation',
    'Revenue Cloud (Core)-OmniStudio'
  ],
  'Revenue Cloud (Core)-Price Management': [
    'Revenue Cloud (Core)-Configurator',
    'Revenue Cloud (Core)-Business Rules Engine',
    'Revenue Cloud (Core)-Product Catalog Management'
  ],
  'Revenue Cloud (Core)-Product Catalog Management': [
    'Revenue Cloud (Core)-Configurator',
    'Revenue Cloud (Core)-Price Management'
  ],
  'Revenue-Salesforce CPQ': [
    'Revenue-CPQ Developer Support',
    'Revenue-Salesforce Billing'
  ],
  'Revenue-CPQ Developer Support': [
    'Revenue-Salesforce CPQ'
  ],
  'Revenue-Salesforce Billing': [
    'Revenue-Salesforce Subscription Management',
    'Revenue-Salesforce CPQ'
  ],
  'Revenue-Salesforce Subscription Management': [
    'Revenue-Salesforce Billing'
  ],
  'Revenue Lifecycle Management-Asset Lifecycle Management': [
    'Revenue Lifecycle Management-Quote to Order Capture',
    'Revenue Lifecycle Management-Developer Support - OmniStudio and DocGen',
    'Revenue Lifecycle Management-Developer Support - Product, Pricing, Config'
  ],
  'Industry-Education Cloud': [
    'Industry-Education Data Architecture (EDA)',
    'Industry-Education Packages (Other SFDO)'
  ],
  'Industry-Education Data Architecture (EDA)': [
    'Industry-Education Cloud'
  ],
  'Industry-Nonprofit Cloud': [
    'Industry-Nonprofit Packages (Other SFDO)',
    'Industry-Nonprofit Success Pack (NPSP)'
  ],
  'Industry-Nonprofit Success Pack (NPSP)': [
    'Industry-Nonprofit Cloud',
    'Industry-Nonprofit Packages (Other SFDO)'
  ],
  'Industry-Loyalty Management': [],
  'Industry-Manufacturing Cloud': [],
  'Industry-Public Sector Solutions': [],
  'Industry-Media Cloud': []
};

export function resolveTargetPts(casePt) {
  if (!casePt) return [];
  const primary = [casePt];
  const related = PT_RELATED[casePt] || [];
  return [...new Set([...primary, ...related])];
}
