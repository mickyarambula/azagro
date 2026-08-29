import { createContext, useContext } from "react";
import type { AclLevel, ModuleId } from "@/lib/erp/acl";

export type AccessState = {
  role: string;
  roleLabel: string;
  ownOnly: boolean;
  acl: Record<string, AclLevel>;
  can: (mod: ModuleId, need?: AclLevel) => boolean;
};

const Ctx = createContext<AccessState | null>(null);

export const AccessProvider = Ctx.Provider;

export function useAccess() {
  const v = useContext(Ctx);
  return (
    v ?? {
      role: "",
      roleLabel: "",
      ownOnly: false,
      acl: {},
      can: () => false,
    }
  );
}
