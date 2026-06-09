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
    'Industry-Health Cloud',
    'Industry-OmniStudio'
  ],
  'Industry-Financial Services': [
    'Industry-OmniStudio',
    'Industry-Health Cloud',
    'Industry-Public Sector Solutions'
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
    'Revenue Cloud (Core)-Developer Support - Invoice to Cash',
    'Revenue Cloud (Core)-Price Management',
    'Revenue Cloud (Core)-Usage & Ratings'
  ],
  'Revenue Cloud (Core)-Transaction Management': [
    'Revenue Cloud (Core)-Advanced Configurator',
    'Revenue Cloud (Core)-Configurator',
    'Revenue Cloud (Core)-Developer Support - Product to Order',
    'Revenue Cloud (Core)-Price Management'
  ],
  'Revenue Cloud (Core)-Dynamic Revenue Orchestration': [
    'Revenue Cloud (Core)-Transaction Management',
    'Revenue Cloud (Core)-Price Management'
  ],
  'Revenue Cloud (Core)-Configurator': [
    'Revenue Cloud (Core)-Product Catalog Management',
    'Revenue Cloud (Core)-Business Rules Engine',
    'Revenue Cloud (Core)-Price Management'
  ],
  'Revenue Cloud (Core)-Contract Lifecycle Management with DocGen': [
    'Revenue Cloud (Core)-OmniStudio',
    'Revenue-Document Generation',
    'Industry-Document Generation'
  ],
  'Revenue Cloud (Core)-Price Management': [
    'Revenue Cloud (Core)-Billing & Invoicing',
    'Revenue Cloud (Core)-Transaction Management',
    'Revenue Cloud (Core)-Dynamic Revenue Orchestration'
  ],
  'Revenue Cloud (Core)-Product Catalog Management': [
    'Revenue Cloud (Core)-Configurator',
    'Revenue Cloud (Core)-Price Management'
  ],
  'Revenue-Salesforce CPQ': [
    'Revenue-CPQ Developer Support',
    'Revenue-Salesforce Subscription Management',
    'Revenue-Salesforce Contracts'
  ],
  'Revenue-CPQ Developer Support': [
    'Revenue-Salesforce CPQ',
    'Revenue-Billing Developer Support'
  ],
  'Revenue-Salesforce Billing': [
    'Revenue-Billing Developer Support'
  ],
  'Revenue-Salesforce Subscription Management': [
    'Revenue-Salesforce CPQ'
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
  'Industry-Loyalty Management': [
    'Industry-Manufacturing Cloud'
  ],
  'Industry-Manufacturing Cloud': [
    'Industry-Loyalty Management',
    'Industry-Business Rules Engine (BRE)',
    'Revenue Cloud (Core)-Business Rules Engine'
  ],
  'Industry-Public Sector Solutions': [
    'Industry-Financial Services',
    'Industry-Business Rules Engine (BRE)',
    'Revenue Cloud (Core)-Business Rules Engine',
    'Industry-Manufacturing Cloud',
    'Industry-OmniStudio'
  ],
  'Industry-Media Cloud': []
};

const _ptKeyMap = Object.fromEntries(
  Object.keys(PT_RELATED).map(k => [k.toLowerCase(), k])
);

export function resolveTargetPts(casePt) {
  if (!casePt) return [];
  const normalizedKey = _ptKeyMap[casePt.toLowerCase()] || casePt;
  const primary = [normalizedKey];
  const related = PT_RELATED[normalizedKey] || [];
  return [...new Set([...primary, ...related])];
}
