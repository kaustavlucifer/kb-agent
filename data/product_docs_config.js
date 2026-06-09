/**
 * Product Documentation Config
 * Maps P&T -> URL patterns for article discovery + AI relevance scoring.
 *
 * Runtime flow:
 * 1. Detect P&T from case -> resolveTargetPts (primary + related)
 * 2. Collect urlPatterns from all resolved P&Ts
 * 3. Parallel: SOSL keyword search + SOQL by URL pattern (cached 24hr)
 * 4. Merge + deduplicate both sets
 * 5. AI scores top 50 against case context, returns max 15
 *
 * urlPatterns: SOQL LIKE fragments for Help_Portal_URL__c
 * breadcrumbs: reference only — documents which doc sections belong to this P&T
 */

export const PRODUCT_DOCS_CONFIG = {
  version: '2026-06-09',

  // --- INDUSTRY CLOUD P&Ts ---

  'Industry-OmniStudio': {
    urlPatterns: ['xcloud.os_', 'ind.doc_gen', 'ind.docgen'],
    breadcrumbs: [
      'Omnistudio',
      'Omnistudio for Managed Packages',
      'Omnistudio Installation and Upgrade',
      'Omnistudio Document Generation'
    ]
  },

  'Industry-Document Generation': {
    urlPatterns: ['ind.doc_gen', 'ind.docgen', 'ind.sf_docgen'],
    breadcrumbs: [
      'Omnistudio Document Generation',
      'Salesforce Document Generation'
    ]
  },

  'Industry-Health Cloud': {
    urlPatterns: ['ind.hc_', 'ind.admin_'],
    breadcrumbs: [
      'Health',
      'Agentforce Life Sciences',
      'Criteria-Based Search and Filter',
      'Virtual Calls',
      'Vlocity Health',
      'Form Framework',
      'Grantmaking',
      'Outcome Management',
      'Program and Case Management'
    ]
  },

  'Industry-Life Sciences': {
    urlPatterns: ['ind.lsc_'],
    breadcrumbs: [
      'Agentforce Life Sciences'
    ]
  },

  'Industry-Financial Services': {
    urlPatterns: ['ind.fsc_', 'ind.insurance_'],
    breadcrumbs: [
      'Financial Services Cloud Admin Guide',
      'Financial Services Cloud Managed Package Installation Guide',
      'Financial Services: Loan Forbearance Solution Kit',
      'Digital Insurance',
      'Action Plans',
      'Actionable Relationship Center',
      'Compliant Data Sharing',
      'Interest Tags',
      'Discovery Framework and Assessments'
    ]
  },

  'Industry-Communication Cloud': {
    urlPatterns: ['ind.comms_', 'ind.cme_'],
    breadcrumbs: [
      'Communications Cloud',
      'Communications, Media, and Energy & Utilities Managed Package'
    ]
  },

  'Industry-Automotive Cloud': {
    urlPatterns: ['ind.auto_'],
    breadcrumbs: [
      'Automotive Cloud'
    ]
  },

  'Industry-Manufacturing Cloud': {
    urlPatterns: ['ind.mfg_'],
    breadcrumbs: [
      'Manufacturing Cloud'
    ]
  },

  'Industry-Retail and Consumer Goods': {
    urlPatterns: ['ind.cg_'],
    breadcrumbs: [
      'Set Up and Maintain Retail Execution',
      'Retail Execution at Your Fingertips',
      'Set up and Maintain Trade Promotion Management '
    ]
  },

  'Industry-Energy & Utilities Cloud': {
    urlPatterns: ['ind.energy_', 'ind.cme_'],
    breadcrumbs: [
      'Energy and Utilities',
      'Communications, Media, and Energy & Utilities Managed Package'
    ]
  },

  'Industry-Media Cloud': {
    urlPatterns: ['ind.media_'],
    breadcrumbs: [
      'Media Cloud'
    ]
  },

  'Industry-Education Cloud': {
    urlPatterns: ['sfdo.ec_', 'sfdo.eda_'],
    breadcrumbs: [
      'Education Cloud',
      'Education Data Architecture (EDA) Documentation',
      'K-12 Architecture Kit Documentation',
      'Student Success Hub Documentation',
      'Admissions Connect'
    ]
  },

  'Industry-Nonprofit Cloud': {
    urlPatterns: ['sfdo.'],
    breadcrumbs: [
      'Nonprofit Cloud',
      'Nonprofit Cloud Case Management Documentation',
      'Nonprofit Success Pack (NPSP) Managed Package',
      'Einstein for Nonprofits Managed Package',
      'foundationConnect Managed Package',
      'Grants Management Managed Package',
      'Nonprofit Experience Manager Managed Package',
      'Outbound Funds Module Managed Package',
      'Program Management Module Managed Package',
      'Volunteers for Salesforce Managed Package (Volunteers for Salesforce)',
      'Gift Entry Manager (GEM) Documentation',
      'Salesforce.org Release Notes',
      'Accounting Subledger',
      'Insights Platform Data Integrity Documentation',
      'Marketing Cloud Engagement for Industries'
    ]
  },

  'Industry-Public Sector Solutions': {
    urlPatterns: ['ind.aps_', 'ind.psc_'],
    breadcrumbs: [
      'Public Sector Solutions'
    ]
  },

  'Industry-Loyalty Management': {
    urlPatterns: ['xcloud.loyalty_'],
    breadcrumbs: [
      'Loyalty Management'
    ]
  },

  'Industry-Business Rules Engine (BRE)': {
    urlPatterns: ['ind.bre_'],
    breadcrumbs: [
      'Business Rules Engine',
      'Decision Tables'
    ]
  },

  'Industry-CPQ / Order Management / Digital Commerce': {
    urlPatterns: ['ind.iom_', 'ind.comms_cpq'],
    breadcrumbs: [
      'Industries Order Management',
      'Vlocity Contract Lifecycle Management'
    ]
  },

  // --- REVENUE CLOUD P&Ts ---

  'Revenue Cloud (Core)-OmniStudio': {
    urlPatterns: ['xcloud.os_'],
    breadcrumbs: [
      'Omnistudio',
      'Omnistudio for Managed Packages',
      'Omnistudio Installation and Upgrade'
    ]
  },

  'Revenue Cloud (Core)-Business Rules Engine': {
    urlPatterns: ['ind.bre_'],
    breadcrumbs: [
      'Business Rules Engine',
      'Decision Tables'
    ]
  },

  'Revenue Cloud (Core)-Contract Lifecycle Management with DocGen': {
    urlPatterns: ['ind.sf_contracts', 'ind.doc_gen', 'ind.sf_docgen'],
    breadcrumbs: [
      'Salesforce Contracts',
      'Omnistudio Document Generation',
      'Salesforce Document Generation',
      'Vlocity Contract Lifecycle Management'
    ]
  },

  'Revenue Cloud (Core)-Billing & Invoicing': {
    urlPatterns: ['ind.billing_', 'ind.invoic'],
    breadcrumbs: [
      'Agentforce Revenue Management'
    ]
  },

  'Revenue Cloud (Core)-Configurator': {
    urlPatterns: ['ind.product_', 'ind.config'],
    breadcrumbs: [
      'Agentforce Revenue Management'
    ]
  },

  'Revenue Cloud (Core)-Price Management': {
    urlPatterns: ['ind.pric'],
    breadcrumbs: [
      'Agentforce Revenue Management'
    ]
  },

  'Revenue Cloud (Core)-Product Catalog Management': {
    urlPatterns: ['ind.product_'],
    breadcrumbs: [
      'Agentforce Revenue Management'
    ]
  },

  'Revenue Cloud (Core)-Transaction Management': {
    urlPatterns: ['ind.transaction', 'ind.qocal'],
    breadcrumbs: [
      'Agentforce Revenue Management'
    ]
  },

  'Revenue Cloud (Core)-Usage & Ratings': {
    urlPatterns: ['ind.usage_', 'ind.rating'],
    breadcrumbs: [
      'Agentforce Revenue Management'
    ]
  },

  'Revenue-Document Generation': {
    urlPatterns: ['ind.doc_gen', 'ind.sf_docgen'],
    breadcrumbs: [
      'Omnistudio Document Generation',
      'Salesforce Document Generation'
    ]
  },

  'Revenue-Salesforce Contracts': {
    urlPatterns: ['ind.sf_contracts'],
    breadcrumbs: [
      'Salesforce Contracts'
    ]
  },

  // --- SHARED / CROSS-CUTTING BREADCRUMBS ---
  // These breadcrumbs appear across multiple P&Ts. Assign as needed.

  'Industry-Net Zero Cloud': {
    urlPatterns: ['ind.netzero_'],
    breadcrumbs: [
      'Report and Reduce Your Carbon Footprint with Net Zero Cloud',
      'Set Up and Maintain Net Zero Cloud'
    ]
  },

  'Industry-CRM Analytics': {
    urlPatterns: ['analytics.bi_', 'analytics.csi_'],
    breadcrumbs: [
      'CRM Analytics',
      'CSI Score (Beta)'
    ]
  }
};

/**
 * All known breadcrumb paths across ind/xcloud/sfdo/analytics namespaces.
 * Use this as a reference when assigning breadcrumbs to P&Ts above.
 *
 * Format: "Breadcrumb Path" [article count] -> namespace
 *
 * INDUSTRY (ind):
 *   - Agentforce Life Sciences [1189]
 *   - Agentforce Revenue Management [1243]
 *   - AI Accelerator and Scoring Framework [51]
 *   - Action Launcher [27]
 *   - Action Plans [51]
 *   - Actionable Relationship Center [21]
 *   - Automotive Cloud [721]
 *   - Batch Management [24]
 *   - Business Rules Engine [160]
 *   - Collections and Recovery [115]
 *   - Communications Cloud [465]
 *   - Communications, Media, and Energy & Utilities Managed Package [1753]
 *   - Compliant Data Sharing [29]
 *   - Context Service [34]
 *   - Criteria-Based Search and Filter [15]
 *   - Cross-Object Field History [6]
 *   - CSV Data Management [10]
 *   - Data Consumption Framework [8]
 *   - Data Processing Engine [92]
 *   - Decision Tables [24]
 *   - Digital Insurance [1806]
 *   - Discovery Framework and Assessments [38]
 *   - Document Checklist Items [22]
 *   - Einstein Autofill [7]
 *   - Einstein Relationship Insights [50]
 *   - Engagement [24]
 *   - Energy and Utilities [384]
 *   - Financial Services Cloud Admin Guide [2004]
 *   - Financial Services Cloud Managed Package Installation Guide [33]
 *   - Financial Services: Loan Forbearance Solution Kit [16]
 *   - Form Framework [9]
 *   - Government Cloud [42]
 *   - Grantmaking [34]
 *   - Group Membership [17]
 *   - Health [1359]
 *   - Identity Verification [50]
 *   - Industries Order Management [378]
 *   - Integration Solutions With MuleSoft [22]
 *   - Intelligent Document Automation [8]
 *   - Intelligent Document Reader [25]
 *   - Intelligent Form Reader [11]
 *   - Interest Tags [13]
 *   - Manufacturing Cloud [622]
 *   - Media Cloud [495]
 *   - Omnistudio Document Generation [151]
 *   - Outcome Management [19]
 *   - Outbound Engagement [11]
 *   - Process Compliance Navigator [109]
 *   - Program and Case Management [77]
 *   - Public Sector Solutions [477]
 *   - Record Alerts [32]
 *   - Report and Reduce Your Carbon Footprint with Net Zero Cloud [284]
 *   - Retail Execution at Your Fingertips [298]
 *   - Rollup Definitions [19]
 *   - Sales Innovations for Industries Clouds [71]
 *   - Salesforce Contracts [414]
 *   - Salesforce Document Generation [111]
 *   - Salesforce Industries [3]
 *   - Service Process Studio [21]
 *   - Set Up and Maintain Net Zero Cloud [129]
 *   - Set Up and Maintain Retail Execution [656]
 *   - Set up and Maintain Trade Promotion Management [620]
 *   - Stage Management [17]
 *   - Sync Management [83]
 *   - Timeline [11]
 *   - Unified Catalog [42]
 *   - Vlocity Contract Lifecycle Management [805]
 *   - Vlocity Government [3]
 *   - Vlocity Health [1]
 *   - Virtual Calls [21]
 *   - Visual Studio Code Based Modeler [558]
 *
 * XCLOUD (xcloud):
 *   - Asset Service Lifecycle Management [263]
 *   - Availability [32]
 *   - Briefcase Builder [17]
 *   - Channel Revenue Management [285]
 *   - Connected Assets [66]
 *   - Data Protection and Privacy [177]
 *   - Digital Wallet [56]
 *   - Essentials [75]
 *   - Explore Salesforce Solution Kits [19]
 *   - Feedback Management [159]
 *   - Get Started with Salesforce [245]
 *   - Identify Your Users and Manage Access [342]
 *   - Loyalty Management [590]
 *   - Mobile Application Security [29]
 *   - Mobile Publisher for Experience Cloud App [172]
 *   - Mobile Publisher for Salesforce App [80]
 *   - Omnistudio [484]
 *   - Omnistudio Installation and Upgrade [42]
 *   - Omnistudio for Managed Packages [1424]
 *   - Partner Cloud [38]
 *   - Quip [259]
 *   - Respect Consent Preferences in Marketing Cloud Engagement [4]
 *   - Salesforce CMS [58]
 *   - Salesforce Data Pipelines [182]
 *   - Salesforce Foundations [33]
 *   - Salesforce Mobile App [103]
 *   - Salesforce Mobile App Plus [37]
 *   - Salesforce Shield Platform Encryption Architecture [55]
 *   - Salesforce Suites [71]
 *   - Salesforce Trust Sites [32]
 *   - SalesforceA [6]
 *   - Scalability [55]
 *   - Secure Your Salesforce Org [568]
 *   - Set Up and Maintain Your Salesforce Organization [750]
 *   - Trailblazer [12]
 *
 * SFDO (sfdo):
 *   - Accounting Subledger [53]
 *   - Admissions Connect [76]
 *   - Education Cloud [674]
 *   - Education Data Architecture (EDA) Documentation [108]
 *   - Einstein for Nonprofits Managed Package [28]
 *   - Gift Entry Manager (GEM) Documentation [25]
 *   - Grants Management Managed Package [95]
 *   - Insights Platform Data Integrity Documentation [37]
 *   - K-12 Architecture Kit Documentation [70]
 *   - Marketing Cloud Engagement for Industries [9]
 *   - Nonprofit Cloud [184]
 *   - Nonprofit Cloud Case Management Documentation [82]
 *   - Nonprofit Experience Manager Managed Package [6]
 *   - Nonprofit Success Pack (NPSP) Managed Package [255]
 *   - Outbound Funds Module Managed Package [58]
 *   - Program Management Module Managed Package [48]
 *   - Salesforce.org Release Notes [174]
 *   - Student Success Hub Documentation [166]
 *   - Volunteers for Salesforce Managed Package (Volunteers for Salesforce) [76]
 *   - foundationConnect Managed Package [13]
 *
 * ANALYTICS (analytics):
 *   - CRM Analytics [1230]
 *   - CSI Score (Beta) [48]
 *   - Reports and Dashboards [385]
 *   - Tableau [13]
 *   - Tableau Next [258]
 */
