export const PT_ROUTING = {
  'health-cloud': {
    ptPatterns: ['Industry-Health Cloud', 'Industry-Health & Insurance', 'Industry-Life Sciences'],
    keywords: [
      'health cloud', 'care plan', 'care gap', 'careplan', 'caregap', 'FHIR', 'HL7',
      'vlocity_ins', 'insurance claim', 'utilization management', 'assessments',
      'benefit verification', 'insurance enrollment', 'provider network', 'virtual care',
      'social determinants', 'DORA', 'clinical data model', 'remote monitoring',
      'member plan', 'authorization request', 'care management'
    ],
    excludeKeywords: ['financial services', 'banking', 'cpq', 'trade promotion']
  },
  'life-sciences': {
    ptPatterns: ['Industry-Life Sciences'],
    keywords: [
      'life sciences', 'clinical trial', 'drug program', 'medtech', 'patient services',
      'consent management', 'REMS', 'companion diagnostics', 'referral management'
    ],
    excludeKeywords: []
  },
  'financial-services': {
    ptPatterns: ['Industry-Financial Services'],
    keywords: [
      'financial services cloud', 'FSC', 'financial account', 'account hierarchy',
      'referral', 'relationship map', 'action plan', 'vlocity_ins_fsc',
      'rollup summary', 'document checklist', 'life event', 'interaction summary',
      'wealth management', 'banking', 'mortgage', 'loan'
    ],
    excludeKeywords: ['health', 'insurance claim', 'care plan']
  },
  'comms-cloud': {
    ptPatterns: ['Industry-Communication Cloud'],
    keywords: [
      'communication cloud', 'comms cloud', 'EPC', 'order decomposition', 'MSM',
      'vlocity_cmt', 'catalog management', 'service qualification', 'CPE',
      'telecom', 'telecommunications', 'network inventory', 'service order',
      'order management', 'enterprise product catalog'
    ],
    excludeKeywords: ['trade promotion', 'consumer goods']
  },
  'omnistudio': {
    ptPatterns: ['Industry-OmniStudio', 'Revenue Cloud (Core)-OmniStudio'],
    keywords: [
      'omnistudio', 'omniscript', 'flexcard', 'dataraptor', 'integration procedure',
      'vlocity_cmt', 'vlocity_ins', 'OmniProcess', 'OmniDataTransform',
      'OmniIntegrationProcedure', 'FlexCard', 'IP', 'VBT'
    ],
    excludeKeywords: []
  },
  'revenue-cloud-core': {
    ptPatterns: [
      'Revenue Cloud (Core)-Advanced Approvals', 'Revenue Cloud (Core)-Billing & Invoicing',
      'Revenue Cloud (Core)-Business Rules Engine', 'Revenue Cloud (Core)-Configurator',
      'Revenue Cloud (Core)-Contract Lifecycle Management with DocGen',
      'Revenue Cloud (Core)-Developer Support - Product to Order',
      'Revenue Cloud (Core)-Dynamic Revenue Orchestration',
      'Revenue Cloud (Core)-Price Management', 'Revenue Cloud (Core)-Product Catalog Management',
      'Revenue Cloud (Core)-Transaction Management', 'Revenue Cloud (Core)-Usage & Ratings'
    ],
    keywords: [
      'revenue cloud', 'billing', 'invoicing', 'BRE', 'business rules engine',
      'decision table', 'expression set', 'context definition', 'configurator',
      'CLM', 'contract lifecycle', 'docgen', 'DRO', 'dynamic revenue orchestration',
      'product-to-order', 'product catalog', 'pricing', 'price management',
      'advanced approvals', 'transaction management', 'usage rating',
      'billing schedule', 'invoice batch', 'credit memo', 'AvaTax', 'Vertex'
    ],
    excludeKeywords: ['SBQQ', 'Steelbrick', 'cpq quote']
  },
  'revenue-lifecycle': {
    ptPatterns: [
      'Revenue Lifecycle Management-Asset Lifecycle Management',
      'Revenue Lifecycle Management-Developer Support - OmniStudio and DocGen',
      'Revenue Lifecycle Management-Developer Support - Product, Pricing, Config',
      'Revenue Lifecycle Management-Quote to Order Capture'
    ],
    keywords: [
      'revenue lifecycle', 'asset lifecycle', 'quote to order'
    ],
    excludeKeywords: []
  },
  'salesforce-cpq': {
    ptPatterns: ['Revenue-Salesforce CPQ', 'Revenue-CPQ Developer Support'],
    keywords: [
      'salesforce cpq', 'SBQQ', 'QCP', 'quote calculator plugin', 'quote line editor',
      'QLE', 'cpq amendment', 'cpq contract', 'cpq pricing rule', 'cpq api',
      'subscription pricing', 'cpq renewal', 'order contracting', 'MDQ',
      'Steelbrick', 'SBQQ__Quote__c', 'SBQQ__QuoteLine__c'
    ],
    excludeKeywords: ['revenue cloud core', 'configurator', 'BRE']
  },
  'salesforce-billing': {
    ptPatterns: ['Revenue-Salesforce Billing', 'Revenue-Salesforce Subscription Management'],
    keywords: [
      'salesforce billing', 'blng__', 'subscription management', 'payment schedule',
      'revenue schedule', 'evergreen subscription'
    ],
    excludeKeywords: ['revenue cloud core', 'billing schedule']
  },
  'document-generation': {
    ptPatterns: ['Industry-Document Generation', 'Revenue-Document Generation'],
    keywords: [
      'document generation', 'docgen', 'document template', 'merge field',
      'word connector', 'clause library', 'PDF generation'
    ],
    excludeKeywords: []
  },
  'rcg': {
    ptPatterns: ['Industry-Retail and Consumer Goods'],
    keywords: [
      'retail', 'consumer goods', 'cgcloud', 'store operations', 'trade promotion',
      'consumer goods cloud', 'retail execution', 'planogram', 'store visit',
      'product hierarchy', 'assortment', 'promotion', 'RCG'
    ],
    excludeKeywords: ['revenue cloud', 'financial', 'health']
  },
  'tpm': {
    ptPatterns: ['Industry-Retail and Consumer Goods'],
    keywords: [
      'trade promotion management', 'TPM', 'KPI calculation', 'nightly batch',
      'push promotion', 'payment claim', 'funding grid', 'cgcloud',
      'RTR report', 'trade spend'
    ],
    excludeKeywords: []
  },
  'energy-utilities': {
    ptPatterns: ['Industry-Energy & Utilities Cloud'],
    keywords: [
      'energy', 'utilities', 'E&U', 'CAM', 'customer acquisition',
      'multisite order', 'VEEDigitalGetBasket', 'DC API', 'meter',
      'usage component', 'energy cloud'
    ],
    excludeKeywords: []
  },
  'media-cloud': {
    ptPatterns: ['Industry-Media Cloud'],
    keywords: [
      'media cloud', 'ad sales', 'ad inventory', 'campaign management',
      'MediaAdSales', 'media business app'
    ],
    excludeKeywords: []
  },
  'education-cloud': {
    ptPatterns: ['Industry-Education Cloud', 'Industry-Education Data Architecture (EDA)', 'Industry-Education Packages (Other SFDO)'],
    keywords: [
      'education cloud', 'EDA', 'education data architecture', 'student',
      'academic', 'enrollment', 'admissions', 'program plan'
    ],
    excludeKeywords: []
  },
  'loyalty': {
    ptPatterns: ['Industry-Loyalty Management'],
    keywords: [
      'loyalty management', 'loyalty program', 'loyalty tier', 'loyalty points',
      'member benefit', 'reward', 'loyalty partner'
    ],
    excludeKeywords: []
  },
  'manufacturing': {
    ptPatterns: ['Industry-Manufacturing Cloud'],
    keywords: [
      'manufacturing cloud', 'sales agreement', 'account forecast',
      'rebate management', 'manufacturing'
    ],
    excludeKeywords: []
  },
  'public-sector': {
    ptPatterns: ['Industry-Public Sector Solutions'],
    keywords: [
      'public sector', 'government', 'permit', 'license', 'inspection',
      'regulatory authority', 'case management'
    ],
    excludeKeywords: ['health', 'financial']
  },
  'nonprofit': {
    ptPatterns: ['Industry-Nonprofit Cloud', 'Industry-Nonprofit Packages (Other SFDO)', 'Industry-Nonprofit Success Pack (NPSP)'],
    keywords: [
      'nonprofit', 'NPSP', 'donation', 'fundraising', 'grant',
      'program management', 'volunteer', 'SFDO'
    ],
    excludeKeywords: []
  },
  'bre': {
    ptPatterns: ['Industry-Business Rules Engine (BRE)', 'Revenue Cloud (Core)-Business Rules Engine'],
    keywords: [
      'business rules engine', 'BRE', 'decision table', 'expression set',
      'context definition', 'lookup table', 'calculation procedure',
      'pricing procedure', 'configuration rule'
    ],
    excludeKeywords: []
  },
  'cpq-order-management': {
    ptPatterns: ['Industry-CPQ / Order Management / Digital Commerce'],
    keywords: [
      'industries cpq', 'order management', 'digital commerce', 'vlocity',
      'order capture', 'order orchestration', 'decomposition'
    ],
    excludeKeywords: ['SBQQ', 'Steelbrick']
  }
};

export function resolveTargetPts(caseProduct, caseSubject, caseDescription) {
  const combinedText = `${caseProduct || ''} ${caseSubject || ''} ${caseDescription || ''}`.toLowerCase();
  const scores = [];

  for (const [verticalId, config] of Object.entries(PT_ROUTING)) {
    let score = 0;
    let excluded = false;

    for (const ex of config.excludeKeywords) {
      if (combinedText.includes(ex.toLowerCase())) {
        excluded = true;
        break;
      }
    }
    if (excluded) continue;

    for (const kw of config.keywords) {
      const kwLower = kw.toLowerCase();
      if (combinedText.includes(kwLower)) {
        score += kwLower.length > 8 ? 3 : kwLower.length > 4 ? 2 : 1;
      }
    }

    if (score > 0) {
      const normalized = (score / config.keywords.length) * 10;
      scores.push({ verticalId, score: normalized, ptPatterns: config.ptPatterns });
    }
  }

  scores.sort((a, b) => b.score - a.score);
  const topVerticals = scores.slice(0, 3);
  const ptPatterns = [...new Set(topVerticals.flatMap(v => v.ptPatterns))];
  return ptPatterns;
}

export function matchPtPatterns(topicName, ptPatterns) {
  if (!topicName || !ptPatterns.length) return false;
  return ptPatterns.some(pattern => topicName === pattern || topicName.startsWith(pattern));
}
