export interface OrganizationLabel {
  id: string;
  name: string;
  color: string;
}

export interface OrganizationRuleCriteria {
  from?: string;
  to?: string;
  subject?: string;
  excludeSubject?: string;
}

export interface OrganizationRuleActions {
  labelIds: string[];
  skipInbox: boolean;
  markRead: boolean;
  spam?: boolean;
}

export interface OrganizationRule {
  id: string;
  name: string;
  enabled: boolean;
  criteria: OrganizationRuleCriteria;
  actions: OrganizationRuleActions;
}

export interface OrganizationState {
  labels: OrganizationLabel[];
  rules: OrganizationRule[];
}

export type OrganizationLabelInput = Omit<OrganizationLabel, 'id'>;
export type OrganizationRuleInput = Omit<OrganizationRule, 'id'>;

export type OrganizationMessage<T extends { id: string }> = T & {
  labels: OrganizationLabel[];
};
