import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  CircularProgress,
  Alert,
  Stack,
} from "@mui/material";
import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { createTemplatesClient } from "@switch-console/chat-ui/client/templates-client";
import { gatewayFetch } from "../../data/gatewayFetch";
import { fetchTemplateContent } from "../../data/api";

const templatesClient = createTemplatesClient({
  call: async (path, request) => {
    return gatewayFetch(`/gateway${path}`, {
      method: request.method ?? "GET",
      headers: request.body ? { "Content-Type": "application/json" } : undefined,
      body: request.body ? JSON.stringify(request.body) : undefined,
    });
  },
});

export interface TemplateRunDialogProps {
  templateId: string;
  templateName: string;
  onClose: () => void;
}

type ParamDef = { name: string; required: boolean };

function parseTemplateParams(yaml: string): ParamDef[] {
  const params: ParamDef[] = [];
  const lines = yaml.split('\n');
  let inParams = false;
  let currentParam: string | null = null;

  for (const line of lines) {
    if (line.match(/^params:\s*$/)) {
      inParams = true;
      continue;
    }
    if (inParams) {
      if (line.match(/^\S/) && !line.startsWith('params')) {
        break;
      }
      const paramMatch = line.match(/^\s{2}(\w+):\s*$/);
      if (paramMatch) {
        currentParam = paramMatch[1];
        params.push({ name: currentParam, required: false });
        continue;
      }
      if (currentParam) {
        const requiredMatch = line.match(/^\s{4}required:\s*(true|false)/);
        if (requiredMatch && requiredMatch[1] === 'true') {
          const param = params.find(p => p.name === currentParam);
          if (param) param.required = true;
        }
      }
    }
  }
  return params;
}

export default function TemplateRunDialog({
  templateId,
  templateName,
  onClose,
}: TemplateRunDialogProps) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templateContent, setTemplateContent] = useState("");
  const [params, setParams] = useState<ParamDef[]>([]);
  const [inputs, setInputs] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchTemplateContent(templateId)
      .then((content) => {
        setTemplateContent(content);
        const parsedParams = parseTemplateParams(content);
        setParams(parsedParams);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load template");
        setLoading(false);
      });
  }, [templateId]);

  const handleRun = async () => {
    const trimmedInputs: Record<string, string> = {};
    for (const [key, value] of Object.entries(inputs)) {
      trimmedInputs[key] = value.trim();
    }

    for (const param of params) {
      if (param.required && (!trimmedInputs[param.name] || trimmedInputs[param.name] === '')) {
        setError(`${param.name} is required`);
        return;
      }
    }

    setRunning(true);
    setError(null);
    try {
      const result = await templatesClient.runTemplateDocument({
        template: templateContent,
        inputs: trimmedInputs,
        filled: {},
        templateName,
        templateId,
      });

      if (result.kind === "refused") {
        setError(result.message);
        setRunning(false);
        return;
      }

      onClose();
      if (result.room) {
        navigate(`/rooms/${result.room.id}`);
      } else if (result.createdAgents.length > 0) {
        navigate(`/agents/${result.createdAgents[0].agentId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run template");
      setRunning(false);
    }
  };

  return (
    <Dialog open onClose={running ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Use {templateName}</DialogTitle>
      <DialogContent>
        {loading ? (
          <Stack alignItems="center" py={3}>
            <CircularProgress />
          </Stack>
        ) : (
          <>
            {error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}
            <Alert severity="info" sx={{ mb: 2 }}>
              Template running from the web is in early development. For full features including agent selection and configuration, use Switch Console.
            </Alert>
            <Stack spacing={2}>
              <TextField
                label="Template"
                value={templateName}
                disabled
                size="small"
              />
              {params.map((param) => (
                <TextField
                  key={param.name}
                  label={param.name}
                  required={param.required}
                  value={inputs[param.name] || ''}
                  onChange={(e) => setInputs({ ...inputs, [param.name]: e.target.value })}
                  size="small"
                  disabled={running}
                />
              ))}
            </Stack>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={running || loading}>
          Cancel
        </Button>
        <Button onClick={handleRun} variant="contained" disabled={running || loading}>
          {running ? <CircularProgress size={20} /> : "Run template"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
