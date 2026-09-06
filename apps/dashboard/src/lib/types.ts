export type ApiEnvelope<T> = {
  data?: T;
  message?: string;
  error?: string | { message?: string; code?: string };
  meta?: { page?: number; limit?: number; total?: number; totalPages?: number };
};

export type AdminUser = {
  id?: string;
  email: string;
  name?: string;
  role?: string;
  mustChangePassword?: boolean;
};

export type SessionPayload = {
  authenticated: boolean;
  user?: AdminUser;
  mustChangePassword?: boolean;
};

export type FieldDefinition = {
  name: string;
  label: string;
  type?:
    "text" | "textarea" | "number" | "password" | "url" | "select" | "checkbox";
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: Array<{ label: string; value: string }>;
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: string | number | boolean;
};

export type ColumnDefinition = {
  key: string;
  label: string;
  format?: "date" | "status" | "boolean" | "secret";
};
