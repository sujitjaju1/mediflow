"use client";

import { ChevronDown, Search, User } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/src/components/ui/Button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/Card";
import { Input } from "@/src/components/ui/Input";
import { Select } from "@/src/components/ui/Select";
import { consultationTypeOptions } from "@/src/lib/consultations/visitTypes";

const FOLLOW_NONE = "_none";

interface PriorConsultationOption {
  id: string;
  created_at: string;
  type: string;
  chief_complaint: string | null;
}

interface PatientOption {
  id: string;
  name: string;
}

interface ReceptionistIntakeCardProps {
  patients: PatientOption[];
}

export function ReceptionistIntakeCard({ patients }: ReceptionistIntakeCardProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [patientId, setPatientId] = useState<string>("");
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [chiefComplaint, setChiefComplaint] = useState("");
  const [visitType, setVisitType] = useState("General");
  const [priorOptions, setPriorOptions] = useState<PriorConsultationOption[]>([]);
  const [followUpOfId, setFollowUpOfId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const searchRootRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return patients;
    return patients.filter((patient) => patient.name.toLowerCase().includes(q));
  }, [patients, query]);

  const selectedPatient = useMemo(() => patients.find((patient) => patient.id === patientId) ?? null, [patients, patientId]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (searchRootRef.current && !searchRootRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  useEffect(() => {
    if (!patientId) {
      setPriorOptions([]);
      setFollowUpOfId("");
      return;
    }
    setFollowUpOfId("");
    setPriorOptions([]);
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/patients/${patientId}/consultations`);
      const data = (await res.json()) as { consultations?: PriorConsultationOption[] };
      if (cancelled) return;
      if (res.ok && Array.isArray(data.consultations)) setPriorOptions(data.consultations);
      else setPriorOptions([]);
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  const followUpSelectOptions = useMemo(() => {
    return [
      { value: FOLLOW_NONE, label: "None (new episode)" },
      ...priorOptions.map((c) => {
        const d = new Date(c.created_at);
        const dateLabel = Number.isNaN(d.getTime()) ? c.created_at : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
        const tail = c.chief_complaint?.trim() ? ` — ${c.chief_complaint.trim().slice(0, 48)}` : "";
        return { value: c.id, label: `${dateLabel} · ${c.type}${tail}` };
      }),
    ];
  }, [priorOptions]);

  function toNumber(value: string) {
    const n = Number(value);
    return Number.isFinite(n) && value.trim() !== "" ? n : null;
  }

  function selectPatient(patient: PatientOption) {
    setPatientId(patient.id);
    setQuery(patient.name);
    setIsDropdownOpen(false);
  }

  async function saveIntake() {
    setError(null);
    setSuccess(null);
    if (!patientId) {
      setError("Select a patient first.");
      return;
    }
    setLoading(true);
    try {
      const createRes = await fetch("/api/consultations/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patient_id: patientId,
          type: visitType,
          chief_complaint: chiefComplaint.trim() || undefined,
          follow_up_of: followUpOfId.trim() || undefined,
        }),
      });
      const createData = (await createRes.json()) as { consultation_id?: string; error?: string };
      if (!createRes.ok || !createData.consultation_id) {
        setError(createData.error ?? "Could not start intake consultation.");
        return;
      }

      const snapshot = {
        chief_complaint: chiefComplaint.trim() || null,
      };

      const emrRes = await fetch(`/api/emr/by-consultation/${createData.consultation_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot }),
      });
      const emrData = (await emrRes.json()) as { error?: string };
      if (!emrRes.ok) {
        setError(emrData.error ?? "Consultation was created but intake details failed to save.");
        return;
      }

      await fetch(`/api/consultations/${createData.consultation_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intake_status: "done", intake_completed_at: new Date().toISOString() }),
      });

      setSuccess("Intake saved. Doctor can continue this consultation.");
      setChiefComplaint("");
      router.refresh();
    } catch {
      setError("Failed to save intake details.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reception Intake</CardTitle>
        <CardDescription>Search one patient bar, then capture complaint and create the consultation.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div ref={searchRootRef} className="relative">
          <Input
            label="Search patient"
            value={query}
            onFocus={() => setIsDropdownOpen(true)}
            onChange={(event) => {
              const next = event.target.value;
              setQuery(next);
              setPatientId("");
              setIsDropdownOpen(true);
            }}
            placeholder="Type patient name"
            iconLeft={<Search className="h-4 w-4" />}
            autoComplete="off"
          />
          <div className="pointer-events-none absolute right-3 top-10 -translate-y-1/2 text-[hsl(var(--text-muted))]">
            <ChevronDown className={`h-4 w-4 transition-transform ${isDropdownOpen ? "rotate-180" : ""}`} />
          </div>
          {isDropdownOpen ? (
            <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-[var(--radius)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-1 shadow-[var(--shadow-md)]">
              {filtered.length ? (
                filtered.map((patient) => (
                  <button
                    key={patient.id}
                    type="button"
                    onClick={() => selectPatient(patient)}
                    className="flex w-full items-center gap-3 rounded-[calc(var(--radius)-4px)] px-3 py-2 text-left text-sm text-[hsl(var(--text-primary))] transition-colors hover:bg-[hsl(var(--bg-secondary))]"
                  >
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[hsl(var(--bg-secondary))] text-[hsl(var(--text-muted))]">
                      <User className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{patient.name}</span>
                      <span className="block text-xs text-[hsl(var(--text-muted))]">Tap to select</span>
                    </span>
                  </button>
                ))
              ) : (
                <div className="px-3 py-2 text-sm text-[hsl(var(--text-muted))]">No patient matches search.</div>
              )}
            </div>
          ) : null}
        </div>

        {selectedPatient ? (
          <div className="rounded-[var(--radius)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-secondary))] px-3 py-2 text-sm text-[hsl(var(--text-secondary))]">
            Selected patient: <span className="font-medium text-[hsl(var(--text-primary))]">{selectedPatient.name}</span>
          </div>
        ) : null}

        <Select value={visitType} onValueChange={setVisitType} options={consultationTypeOptions} placeholder="Visit type" />
        {patientId && priorOptions.length ? (
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-[hsl(var(--text-secondary))]">Follow-up of (optional)</p>
            <Select
              value={followUpOfId || FOLLOW_NONE}
              onValueChange={(v) => setFollowUpOfId(v === FOLLOW_NONE ? "" : v)}
              options={followUpSelectOptions}
              placeholder="Link to prior visit"
            />
          </div>
        ) : null}
        <Input
          label="Chief complaint"
          value={chiefComplaint}
          onChange={(event) => setChiefComplaint(event.target.value)}
          placeholder="Fever since 2 days"
        />
        {error ? <p className="text-xs text-[hsl(var(--danger))]">{error}</p> : null}
        {success ? <p className="text-xs text-[hsl(var(--success))]">{success}</p> : null}
        <Button onClick={saveIntake} loading={loading}>
          Save Intake and Create Consultation
        </Button>
      </CardContent>
    </Card>
  );
}
