
import axios from "axios";
import { CloudFormation } from "aws-sdk";

import { sleep } from "../lib/utils";

const { REGIONS, SLACK_URL } = process.env
const regions = REGIONS.split(",");

export async function detectDriftsHandler(event, context, callback) {
    try {
        const numOfRounds = +event["numOfRounds"];
        const sleepBetweenRounds = +event["sleepBetweenRounds"];
        const sleepBetweenDetectionCalls = +event["sleepBetweenDetectionCalls"];
        await detectDrifts(numOfRounds, sleepBetweenRounds, sleepBetweenDetectionCalls);
    } catch(err) {
        console.error(err);
        callback("Internal error");
    }
}

async function detectDrifts(numOfRounds, sleepBetweenRounds, sleepBetweenDetectionCalls){
    for(const region of regions){
        console.log("Examining region", region);
        const cloudformation = new CloudFormation({region});
        const stacks = await getAllStacks(cloudformation);
        console.log("Found number of stacks:", stacks.length);
        const driftDetections = []
        for(const stack of stacks){
            if(!isStackInTransition(stack.StackStatus)){
                /* You might see drift detection requests getting failed due to rate limits exceeded, 
                create a support ticket to increase that limit
                */
                await sleep(sleepBetweenDetectionCalls);
                const res = await cloudformation.detectStackDrift({StackName: stack.StackName}).promise()
                driftDetections.push({driftDetectionId: res.StackDriftDetectionId, stackName: stack.StackName})
            }
        }
        for(let i=0; i < numOfRounds; i++) {
            if(driftDetections.length < 1){
                break;
            }
            console.log("Round", i + 1);
            await sleep(sleepBetweenRounds * 1000);
            for(const driftIndex in driftDetections){
                const driftDetection = driftDetections[driftIndex];
                const driftStatus = await cloudformation.describeStackDriftDetectionStatus({StackDriftDetectionId: driftDetection.driftDetectionId}).promise()
                console.log("driftStatus", driftStatus); 
                if(driftStatus.DetectionStatus !== "DETECTION_IN_PROGRESS" && driftStatus.StackDriftStatus === "DRIFTED"){
                    const resourceDrifts = await cloudformation.describeStackResourceDrifts({StackName: driftDetection.stackName, StackResourceDriftStatusFilters: ["IN_SYNC", "MODIFIED", "DELETED"]}).promise();
                    const url = `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stack/detail?stackId=${driftStatus.StackId}`;
                    const message = `Cloudformation Drift detected for the stack: ${url}`;
                    await sendSlackMessage({message, data: resourceDrifts, url});
                    console.log(`Slack message sent for stack: ${driftDetection.stackName}`)
                    driftDetections.splice(driftIndex, 1);
                }
            }
        }
    }
}

async function getAllStacks(cloudformation){
    let lastKey = null;
    let arr = [];
    const params = {};
    do{
      if(lastKey){
          params.NextToken = lastKey;
          const result = await cloudformation.describeStacks(params).promise();
          lastKey = result.LastEvaluatedKey;
          arr = [...arr,...result.Stacks];
      }else{
          const result = await cloudformation.describeStacks(params).promise();
          lastKey = result.NextToken;
          arr = [...arr,...result.Stacks];
        }
      }while(lastKey);
    return arr;
  }


function sendSlackMessage(params) {
    const payload = {
        attachments: [
            {
                "pretext": params.message,
                "title": "Cloudformation Drift Detected",
                "title_link": params.url,
                "text": JSON.stringify(params.data),
                "color": "#800000"
            }
        ]
    }
    return axios.request({
        url: SLACK_URL,
        method: "POST",
        data: payload
    })
}

function isStackInTransition(stack) {
    const transitions = ["CREATE_IN_PROGRESS", "CREATE_FAILED","ROLLBACK_FAILED","DELETE_FAILED","UPDATE_ROLLBACK_FAILED","UPDATE_IN_PROGRESS","REVIEW_IN_PROGRESS","DELETE_IN_PROGRESS", "ROLLBACK_COMPLETE"]
    if(transitions.find(x=>x===stack)) {
        return true;
    }else {
        false;
    }
}