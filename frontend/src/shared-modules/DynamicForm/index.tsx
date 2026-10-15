import React, { useState } from 'react';
  import { useForm, type FieldErrors } from 'react-hook-form';
  import { Icon } from '@iconify/react';
  import type { ComponentMetadata } from '../../types';

  interface ValidationRule {
    value: any;
    message: string;
  }

  interface FormFieldValidation {
    minLength?: ValidationRule;
    maxLength?: ValidationRule;
    min?: ValidationRule;
    max?: ValidationRule;
    pattern?: ValidationRule;
  }

  interface FormField {
    name: string;
    description?: string;
    type: 'text' | 'number' | 'email' | 'date' | 'time' | 'datetime' | 'url' | 'password' | 'select' | 'multiselect' |
  'checkbox' | 'textarea' | 'file';
    required?: boolean;
    defaultValue?: any;
    placeholder?: string;
    options?: string[] | Array<{[key: string]: any}>;
    validation?: FormFieldValidation;
  }

  interface ExternalTool {
    toolId: string;
    toolName: string;
    parameters: Record<string, any>;
  }

  interface DynamicFormProps {
    title?: string;
    description?: string;
    query?: {
      sql: string;
      params?: any[];
    } | null;
    externalTool?: ExternalTool | null;
    fields?: FormField[];
    submitButtonText?: string;
    submitButtonColor?: 'primary' | 'danger';
    successMessage?: string;
    disableFields?: boolean;
    SA_RUNTIME?: any;
  }

  const METADATA: ComponentMetadata = {
    id: 'dynamic-form',
    name: 'DynamicForm',
    type: 'Form',
    displayName: 'Dynamic Form Component',
    isDisplayComp: false,
    description: 'A form component for collecting user input with mutation support. IMPORTANT: Use EITHER query OR externalTool for form submission, NEVER BOTH. For database mutations use query and set externalTool to null. For external API calls set query to null and provide externalTool object. Supports text, number, email, date, time, datetime, url, password, select, multiselect, checkbox, and textarea field types.',
    category: 'inputs',
    keywords: ['form', 'input', 'mutation', 'update', 'edit', 'create', 'delete', 'multiselect', 'checkbox', 'external', 'tool', 'api'],
    props: {
      title: 'Form title, eg. Update Order or Delete Product or Create Contact',
      description: 'Form description, eg. Update order status and payment information',
      query: {
        sql: 'Mutation query with $fieldName placeholders, eg. UPDATE orders SET status = $status WHERE order_id = 1 OR DELETE FROM orders WHERE order_id = 1. Set to null if using externalTool.',
        params: 'Optional query parameters[]',
      },
      externalTool: 'Set to null if using query. Otherwise provide: { toolId: "registered-tool-id", toolName: "Display Name", parameters: { param1: value1 } }',
      submitButtonText: 'Button text, default: "Submit". For delete: "Delete", "Confirm Delete", etc.',
      submitButtonColor: 'Button color: "primary" (blue) or "danger" (red). Use "danger" for delete operations.',
      successMessage: 'Success message text, default: "Form submitted successfully!". For delete: "Record deleted successfully!"',
      disableFields: 'Set true for DELETE operations to show values but prevent editing (default: false)',
      fields: [
        {
          name: 'Field name (used as variable in mutation query or external tool data), eg. email',
          description: 'Field description, eg. Email Address',
          type: 'Field type: text|number|email|date|time|datetime|url|password|select|multiselect|checkbox|textarea',
          required: 'Whether field is required (true or false)',
          defaultValue: 'Default value (CRITICAL for UPDATE/DELETE - populate with current value from database)',
          placeholder: 'Placeholder text',
          options: 'List of options for select/multiselect (string array like ["Option1", "Option2"] OR object array like [{"id": 1, "name": "Option1"}])',
          validation: {
            minLength: '{ value: 5, message: "Must be at least 5 characters" }',
            maxLength: '{ value: 100, message: "Must be less than 100 characters" }',
            min: '{ value: 18, message: "Must be at least 18" } (for number fields)',
            max: '{ value: 120, message: "Must be less than 120" } (for number fields)',
            pattern: '{ value: "^[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}$", message: "Invalid email format" }',
          }
        }
      ]
    }
  };

  interface DynamicFormComponent extends React.FC<DynamicFormProps> {
    Metadata: ComponentMetadata;
  }

  const DEFAULT_PROPS: any = {
    title: 'Update Order',
    description: 'Update order status and payment information',
    query: {
      sql: 'UPDATE orders SET status = $status, payment_method = $payment_method WHERE order_id = 1',
      params: [],
    },
    fields: [
      {
        name: 'status',
        description: 'Order Status',
        type: 'select' as const,
        required: true,
        defaultValue: 'Pending',
        placeholder: 'Select status',
        options: ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled', 'Failed'],
      },
      {
        name: 'payment_method',
        description: 'Payment Method',
        type: 'select' as const,
        required: true,
        defaultValue: 'Credit Card',
        placeholder: 'Select payment method',
        options: ['Credit Card', 'Debit Card', 'PayPal', 'Apple Pay'],
      }
    ]
  };

  const DynamicForm: React.FC<DynamicFormProps> = ({
    title = DEFAULT_PROPS.title,
    description = DEFAULT_PROPS.description,
    query = DEFAULT_PROPS.query,
    externalTool = null,
    fields = DEFAULT_PROPS.fields,
    submitButtonText = 'Submit',
    submitButtonColor = 'primary',
    successMessage = 'Form submitted successfully!',
    disableFields = false,
    SA_RUNTIME = {}
  }) => {
    const [loading, setLoading] = useState<boolean>(false);
    const [submitSuccess, setSubmitSuccess] = useState<boolean>(false);
    const [submitError, setSubmitError] = useState<string | null>(null);

    const uid = SA_RUNTIME?.uiBlockId || Math.random().toString(36).substring(2, 15);

    const defaultValues = React.useMemo(() => {
      const values: Record<string, any> = {};
      fields.forEach((field: FormField) => {
        if (field.defaultValue !== undefined) {
          values[field.name] = field.defaultValue;
        } else if (field.type === 'checkbox') {
          values[field.name] = false;
        } else {
          values[field.name] = '';
        }
      });
      return values;
    }, [fields]);

    const { register, handleSubmit, formState: { errors }, reset } = useForm({
      defaultValues,
      mode: 'onBlur'
    });

    React.useEffect(() => {
      reset(defaultValues);
    }, [fields, reset, defaultValues]);

    const buildValidationRules = (field: FormField) => {
      const rules: any = {};
      if (field.required) {
        rules.required = `${field.description || field.name} is required`;
      }
      if (field.validation) {
        if (field.validation.minLength) {
          rules.minLength = { value: field.validation.minLength.value, message: field.validation.minLength.message };
        }
        if (field.validation.maxLength) {
          rules.maxLength = { value: field.validation.maxLength.value, message: field.validation.maxLength.message };
        }
        if (field.validation.min) {
          rules.min = { value: field.validation.min.value, message: field.validation.min.message };
        }
        if (field.validation.max) {
          rules.max = { value: field.validation.max.value, message: field.validation.max.message };
        }
        if (field.validation.pattern) {
          rules.pattern = { value: new RegExp(field.validation.pattern.value), message: field.validation.pattern.message };        
        }
      }
      return rules;
    };

    const onSubmit = async (formValues: Record<string, any>) => {
      setLoading(true);
      setSubmitError(null);
      setSubmitSuccess(false);
      try {
        // Check if this is an external tool form or a database mutation form
        if (externalTool && externalTool.toolId) {
          // External Tool Execution
          console.log('Executing external tool:', externalTool.toolName);
          console.log('Tool ID:', externalTool.toolId);
          console.log('Tool parameters:', externalTool.parameters);
          console.log('Form data:', formValues);

          const toolExecutor = (window as any).SA?.ToolExecutor;
          if (!toolExecutor) {
            throw new Error('ToolExecutor not available');
          }

          const result = await toolExecutor.executeTool({
            externalTool: externalTool,
            formData: formValues,
            SA_RUNTIME
          });

          console.log('External tool result:', result);
          setSubmitSuccess(true);
          setTimeout(() => setSubmitSuccess(false), 3000);
        } else if (query && query.sql) {
          // Database Mutation Execution
          const mutationQuery = { sql: query.sql, params: query.params || [], values: formValues };
          console.log('Executing mutation:', mutationQuery);

          const queryExecutor = (window as any).SA?.QueryExecutor;
          if (!queryExecutor) {
            throw new Error('QueryExecutor not available');
          }

          const result = await queryExecutor.executeQuery({
            query: JSON.stringify(mutationQuery),
            type: 'mutation',
            SA_RUNTIME
          });

          console.log('Mutation result:', result);
          setSubmitSuccess(true);
          setTimeout(() => setSubmitSuccess(false), 3000);
        } else {
          throw new Error('No mutation query or external tool provided');
        }
      } catch (err) {
        console.error('Error submitting form:', err);
        setSubmitError(err instanceof Error ? err.message : 'Failed to submit form');
      } finally {
        setLoading(false);
      }
    };

    const renderFormField = (field: FormField, index: number) => {
      const validationRules = buildValidationRules(field);
      const fieldError = errors[field.name];

      const labelContent = (
        <label className="label">
          <span className="label-text font-semibold">
            {field.description || field.name}
            {field.required && <span className="text-error ml-1">*</span>}
          </span>
        </label>
      );

      const errorContent = fieldError && (
        <label className="label">
          <span className="label-text-alt text-error flex items-center gap-1">
            <Icon icon="mdi:alert-circle" className="w-4 h-4" />
            {fieldError.message as string}
          </span>
        </label>
      );

      switch (field.type) {
        case 'textarea':
          return (
            <div key={uid + index} className="form-control w-full">
              {labelContent}
              <textarea
                {...register(field.name, validationRules)}
                placeholder={field.placeholder}
                disabled={disableFields || loading}
                rows={4}
                className={`textarea textarea-bordered w-full ${fieldError ? 'textarea-error' : ''}`}
              />
              {errorContent}
            </div>
          );

        case 'select':
          const rawOptions = field.options || [];
          const selectOptions = rawOptions.map((opt: any) => {
            if (typeof opt === 'string') return { label: opt, value: opt };
            if (opt.label && opt.value !== undefined) return opt;
            const keys = Object.keys(opt);
            const labelKey = keys.find(k => k?.toLowerCase().includes('name')) || keys[1] || keys[0];
            const valueKey = keys.find(k => k?.toLowerCase().includes('id')) || keys[0];
            return { label: String(opt[labelKey]), value: opt[valueKey] };
          });
          return (
            <div key={uid + index} className="form-control w-full">
              {labelContent}
              <select
                {...register(field.name, validationRules)}
                disabled={disableFields || loading}
                className={`select select-bordered w-full ${fieldError ? 'select-error' : ''}`}
              >
                <option value="">{field.placeholder || 'Select an option'}</option>
                {selectOptions.map((option: any, idx: number) => (
                  <option key={option.value || idx} value={option.value}>{option.label}</option>
                ))}
              </select>
              {errorContent}
            </div>
          );

        case 'multiselect':
          const multiselectRawOptions = field.options || [];
          const multiselectOptions = multiselectRawOptions.map((opt: any) => {
            if (typeof opt === 'string') return { label: opt, value: opt };
            if (opt.label && opt.value !== undefined) return opt;
            const keys = Object.keys(opt);
            const labelKey = keys.find(k => k?.toLowerCase().includes('name')) || keys[1] || keys[0];
            const valueKey = keys.find(k => k?.toLowerCase().includes('id')) || keys[0];
            return { label: String(opt[labelKey]), value: opt[valueKey] };
          });
          return (
            <div key={uid + index} className="form-control w-full">
              {labelContent}
              <select
                {...register(field.name, validationRules)}
                disabled={disableFields || loading}
                multiple
                className={`select select-bordered w-full min-h-[120px] ${fieldError ? 'select-error' : ''}`}
              >
                {multiselectOptions.map((option: any, idx: number) => (
                  <option key={option.value || idx} value={option.value}>{option.label}</option>
                ))}
              </select>
              <label className="label">
                <span className="label-text-alt opacity-60">Hold Ctrl (Cmd on Mac) to select multiple options</span>
              </label>
              {errorContent}
            </div>
          );

        case 'checkbox':
          return (
            <div key={uid + index} className="form-control">
              <label className="label cursor-pointer justify-start gap-3">
                <input
                  type="checkbox"
                  {...register(field.name, validationRules)}
                  disabled={disableFields || loading}
                  className="checkbox checkbox-primary"
                />
                <span className="label-text font-medium">
                  {field.description || field.name}
                  {field.required && <span className="text-error ml-1">*</span>}
                </span>
              </label>
            </div>
          );

        default:
          return (
            <div key={uid + index} className="form-control w-full">
              {labelContent}
              <input
                type={field.type}
                {...register(field.name, validationRules)}
                placeholder={field.placeholder}
                disabled={disableFields || loading}
                className={`input input-bordered w-full ${fieldError ? 'input-error' : ''}`}
              />
              {errorContent}
            </div>
          );
      }
    };

    return (
      <div className="w-full h-full bg-base-200 overflow-auto p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          {/* Form Card */}
          <div className="card bg-base-100 shadow-sm border border-base-300">
            <div className="card-body">
              {/* Header */}
              <div className="mb-4">
                <h2 className="card-title text-xl">{title}</h2>
                {description && <p className="text-sm opacity-60 mt-1">{description}</p>}
              </div>

              {/* Form */}
              <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                {fields.map((field: FormField, index: number) => renderFormField(field, index))}

                {/* Success Alert */}
                {submitSuccess && (
                  <div className="alert alert-success">
                    <Icon icon="mdi:check-circle" className="w-5 h-5 flex-shrink-0" />
                    <span>{successMessage}</span>
                  </div>
                )}

                {/* Error Alert */}
                {submitError && (
                  <div className="alert alert-error">
                    <Icon icon="mdi:alert-circle" className="w-5 h-5 flex-shrink-0" />
                    <span>{submitError}</span>
                  </div>
                )}

                {/* Submit Button */}
                <div className="pt-2">
                  <button
                    type="submit"
                    disabled={loading}
                    className={`btn w-full gap-2 ${submitButtonColor === 'danger' ? 'btn-error' : 'btn-primary'}`}
                  >
                    {loading ? (
                      <>
                        <span className="loading loading-spinner loading-sm"></span>
                        <span>Submitting...</span>
                      </>
                    ) : (
                      <>
                        <Icon icon={submitButtonColor === 'danger' ? 'mdi:delete' : 'mdi:send'} className="w-5 h-5" />
                        <span>{submitButtonText}</span>
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>

        </div>
      </div>
    );
  };

  (DynamicForm as DynamicFormComponent).Metadata = METADATA;

  export default DynamicForm;