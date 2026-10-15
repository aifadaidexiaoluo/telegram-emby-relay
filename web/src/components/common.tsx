import { cloneElement, isValidElement, useId } from "react"
import type { ReactNode } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { statusLabels } from "./workspace"

export function Heading({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="heading">
      <div>
        <p className="eyebrow">RELAY / MEDIA WORKSPACE</p>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {action}
    </div>
  )
}
export function Panel({
  title,
  children,
  action,
}: {
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <Card className="panel">
      <CardHeader className="panel-head">
        <CardTitle>{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}
export function Field({
  label,
  children,
  help,
}: {
  label: string
  children: ReactNode
  help?: string
}) {
  const id = useId()
  return (
    <div className="field">
      <Label className="field-label" htmlFor={id}>
        {label}
      </Label>
      {isValidElement<{ id?: string }>(children)
        ? cloneElement(children, { id })
        : children}
      {help && <small className="muted">{help}</small>}
    </div>
  )
}
export function SelectInput({
  id,
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  required,
}: {
  id?: string
  value: string
  onValueChange: (value: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  disabled?: boolean
  required?: boolean
}) {
  return (
    <Select
      value={value || null}
      onValueChange={(next) => onValueChange(next ?? "")}
      items={options}
      disabled={disabled}
      required={required}
    >
      <SelectTrigger id={id} className="w-full min-w-0">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
export function Status({
  value,
  scan = false,
}: {
  value: string
  scan?: boolean
}) {
  return (
    <Badge
      variant={
        ["failed", "offline", "login_required", "error"].includes(value)
          ? "destructive"
          : "secondary"
      }
    >
      {scan && value === "completed"
        ? "扫描完成"
        : scan && value === "waiting"
          ? "等待扫描"
          : (statusLabels[value] ?? value)}
    </Badge>
  )
}
export function Empty({ children = "暂无数据。" }: { children?: ReactNode }) {
  return <div className="empty">{children}</div>
}
export function DataTable({
  headers,
  rows,
  empty,
}: {
  headers: string[]
  rows: { key: string; cells: ReactNode[] }[]
  empty?: string
}) {
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            {headers.map((header) => (
              <TableHead key={header}>{header}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              {row.cells.map((cell, i) => (
                <TableCell key={i}>{cell}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rows.length === 0 && <Empty>{empty ?? "暂无数据。"}</Empty>}
    </>
  )
}
