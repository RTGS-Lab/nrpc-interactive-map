# **Use Case 1 — Internal Use Only (Single Organization Planning → Action)**

## **Objective**

Enable a single jurisdiction (e.g., county, city, watershed district) to translate existing prioritization models into **implementation-ready projects**.

## **Primary Users**

* Planning staff  
* Natural resources staff  
* GIS analysts  
* Program managers

## **Inputs**

* Metropolitan Council prioritization layers  
* Hennepin County prioritization layers (e.g., conservation easements)  
* Internal datasets (parcels, infrastructure, known problem areas)

## **Workflow**

### **Step 1 — Define Scope**

* Select jurisdiction boundary (auto-filter layers)  
* Optionally segment by:  
  * Subwatershed  
  * Land use type  
  * Program area (e.g., habitat, water quality)

### **Step 2 — Activate Prioritization Layers**

* Toggle:  
  * Met Council model outputs  
  * County prioritization layers  
* Adjust opacity / stacking to identify **high-value overlaps**

### **Step 3 — Identify Candidate Opportunities**

* Staff visually scan \+ query:  
  * High-priority clusters  
  * Gaps in current programming  
* Use filtering tools:  
  * Parcel ownership  
  * Land cover  
  * Impairment status

### **Step 4 — Create “Opportunity Points”**

* Add point (or polygon) to **Opportunities Layer**  
* Required attributes:  
  * Title  
  * Description  
  * Priority level  
  * Program alignment  
  * Estimated feasibility  
  * Staff owner

### **Step 5 — Internal Review \+ Refinement**

* Weekly or sprint-based review:  
  * Validate feasibility  
  * Remove duplicates  
  * Rank opportunities

### **Step 6 — Plan Development**

* Export:  
  * Map layers  
  * Opportunity dataset  
* Feed into:  
  * Comprehensive Plan (e.g., 2050 Comp Plan)  
  * Capital improvement planning  
  * Grant targeting

## **Outputs**

* Structured opportunity inventory  
* Spatially explicit project list  
* Plan-aligned implementation pipeline

## **System Requirements**

* Layer stacking \+ filtering  
* Editable feature layer (points/polygons)  
* Attribute schema enforcement  
* Export (GeoJSON, CSV, report-ready formats)

---

# **Use Case 2 — Internal \+ 1–2 Close Partners (Coordinated Planning)**

## **Objective**

Coordinate across a **small set of aligned entities** to identify shared opportunities and reduce fragmentation.

## **Primary Users**

* County \+ watershed district  
* Adjacent municipalities  
* Implementation partners

## **Additional Inputs**

* Partner datasets (e.g., watershed plans, capital plans)  
* Shared priorities (e.g., TMDLs, flood mitigation zones)

## **Workflow**

### **Step 1 — Joint Scope Definition**

* Select combined geography:  
  * Multi-jurisdiction overlay  
* Define shared goals:  
  * Example: phosphorus reduction, habitat corridors

### **Step 2 — Shared Layer Environment**

* Enable:  
  * All Level 1 layers  
  * Partner-specific layers  
* Add:  
  * “Jurisdiction ownership” overlay

### **Step 3 — Joint Opportunity Identification**

* Partners independently add **Opportunity Points**  
* Tag each with:  
  * Organization  
  * Collaboration potential (low / medium / high)

### **Step 4 — Structured Coordination**

* Use facilitated sessions (recommended):  
  * Review overlaps  
  * Identify:  
    * Redundant efforts  
    * Synergies  
* Merge or split opportunities as needed

### **Step 5 — Assign Roles**

* For each opportunity:  
  * Lead organization  
  * Supporting partners  
  * Coordination needs

### **Step 6 — Prioritize Cross-Boundary Projects**

* Rank based on:  
  * Multi-benefit impact  
  * Funding leverage  
  * Implementation feasibility

### **Step 7 — Export \+ Alignment**

* Outputs feed into:  
  * Multiple plans simultaneously  
  * Joint funding proposals  
  * Interagency agreements

## **Outputs**

* Coordinated opportunity map  
* Reduced duplication  
* Defined ownership \+ collaboration structure

## **System Requirements**

* Multi-user editing  
* Attribution by organization  
* Commenting / discussion threads  
* Version control or change tracking

## **Critical Addition**

A **Collaboration Guide** is necessary:

* Defines meeting cadence  
* Data standards  
* Conflict resolution rules

---

# **Use Case 3 — Full Participatory Mapping (Planning \+ Public Engagement \+ Co-Production)**

## **Objective**

Integrate **community, stakeholders, and practitioners** into the identification of opportunities—while maintaining technical rigor.

## **Primary Users**

* All Level 2 users  
* Community members  
* NGOs  
* Landowners  
* Contractors

## **Additional Inputs**

* Workshop outputs  
* Community feedback  
* Field observations  
* Local knowledge

## **Workflow**

### **Step 1 — Prepare Public-Facing Map**

* Simplify layer stack:  
  * Curated subset of technical layers  
* Enable:  
  * Pop-ups with plain-language explanations  
  * Guided navigation

### **Step 2 — Conduct Workshops**

* In-person or virtual sessions:  
  * Walk through:  
    * Priority areas  
    * Existing constraints  
* Participants:  
  * Identify opportunities  
  * Flag concerns

### **Step 3 — Capture Participatory Input**

* Add features via:  
  * Facilitator-led input  
  * Direct user input (if enabled)  
* Required attributes:  
  * Opportunity type  
  * Local context  
  * Contact (optional)

### **Step 4 — Validate \+ Filter**

* Internal review to:  
  * Remove infeasible suggestions  
  * Flag high-value local insights

### **Step 5 — Integrate with Technical Layers**

* Overlay participatory inputs with:  
  * Prioritization models  
* Identify:  
  * High alignment (priority \+ community support)  
  * Conflicts

### **Step 6 — Final Opportunity Set**

* Combine:  
  * Technical opportunities  
  * Participatory inputs  
* Tag:  
  * Community-supported  
  * High-priority technical

### **Step 7 — Feedback Loop**

* Share results back:  
  * Public dashboards  
  * Reports  
* Maintain transparency

## **Outputs**

* Socially validated project list  
* Increased legitimacy and buy-in  
* Improved implementation success

## **System Requirements**

* Public access layer (permissioned)  
* Pop-ups \+ narrative UI  
* Workshop mode (simplified UX)  
* Data moderation tools

