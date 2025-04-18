const core = require('@actions/core');
const github = require('@actions/github');
const asana = require('asana');

async function moveSection(client, taskId, targets) {
  const task = await client.tasks.findById(taskId);

  targets.forEach(async target => {
    const targetProject = task.projects.find(project => project.name === target.project);
    if (!targetProject) {
      core.info(`This task does not exist in "${target.project}" project`);
      return;
    }
    let targetSection = await client.sections.findByProject(targetProject.gid)
      .then(sections => sections.find(section => section.name === target.section));
    if (targetSection) {
      await client.sections.addTask(targetSection.gid, { task: taskId });
      core.info(`Moved to: ${target.project}/${target.section}`);
    } else {
      core.error(`Asana section ${target.section} not found.`);
    }
  });
}

async function findComment(client, taskId, commentId) {
  let stories;
  try {
    const storiesCollection = await client.tasks.stories(taskId);
    stories = await storiesCollection.fetch(200);
  } catch (error) {
    throw error;
  }

  return stories.find(story => story.text.indexOf(commentId) !== -1);
}

async function addComment(client, taskId, commentId, text, isPinned) {
  if(commentId){
    text += '\n'+commentId+'\n';
  }
  try {
    const comment = await client.tasks.addComment(taskId, {
      text: text,
      is_pinned: isPinned,
    });
    return comment;
  } catch (error) {
    console.error('rejecting promise', error);
  }
}

async function buildClient(asanaPAT) {
  return asana.Client.create({
    defaultHeaders: { 'asana-enable': 'new-sections,string_ids' },
    logAsanaChangeWarnings: false
  }).useAccessToken(asanaPAT).authorize();
}

async function checkTaskDescription(client, taskId, searchString) {
  try {
    const task = await client.tasks.findById(taskId);
    return task.notes && task.notes.includes(searchString);
  } catch (error) {
    core.error(`Error checking task description: ${error.message}`);
    return false;
  }
}

async function action() {  
  const 
    ASANA_PAT = core.getInput('asana-pat', {required: true}),
    ACTION = core.getInput('action', {required: true}),
    TRIGGER_PHRASE = core.getInput('trigger-phrase') || '',
    PULL_REQUEST = github.context.payload.pull_request,
    REGEX_STRING1 = `${TRIGGER_PHRASE}*\\[(.*?)\\]\\(https:\/\/app.asana.com\\/(\\d+)\\/(?<workspace>\\d+)\\/project\\/(?<project>\\d+)\\/task\\/(?<task>\\d+).*?\\)`,
    REGEX_STRING2 = `${TRIGGER_PHRASE}(?:\\s*)https:\/\/app.asana.com\\/(\\d+)\\/(?<project>\\d+)\\/(?<task>\\d+)`,
    REGEX1 = new RegExp(REGEX_STRING1,'g'),
    REGEX2 = new RegExp(REGEX_STRING2,'g')
  ;

  console.log('pull_request', PULL_REQUEST);

  const client = await buildClient(ASANA_PAT);
  if(client === null){
    throw new Error('client authorization failed');
  }

  console.info('looking in body', PULL_REQUEST.body, 'regex1', REGEX_STRING1, 'regex2', REGEX_STRING2);
  let foundAsanaTasks = [];
  let match;
  // first try markdown link style
  while ((match = REGEX1.exec(PULL_REQUEST.body)) !== null) {
    const taskId = match.groups.task;
    if (!taskId) {
      core.error(`Invalid Asana task URL after the trigger phrase ${TRIGGER_PHRASE}`);
      continue;
    }
    foundAsanaTasks.push(taskId);
  }
  // fallback to raw URL style if none found
  if (foundAsanaTasks.length === 0) {
    while ((match = REGEX2.exec(PULL_REQUEST.body)) !== null) {
      const taskId = match.groups.task;
      if (!taskId) {
        core.error(`Invalid Asana task URL after the trigger phrase ${TRIGGER_PHRASE}`);
        continue;
      }
      foundAsanaTasks.push(taskId);
    }
  }
  console.info(`found ${foundAsanaTasks.length} taskIds:`, foundAsanaTasks.join(','));

  console.info('calling', ACTION);
  switch(ACTION){
    case 'assert-link': {
      const githubToken = core.getInput('github-token', {required: true});
      const linkRequired = core.getInput('link-required', {required: true}) === 'true';
      const descriptionSearch = core.getInput('description-contains');
      const octokit = new github.GitHub(githubToken);

      let statusState = (!linkRequired || foundAsanaTasks.length > 0) ? 'success' : 'error';
      let statusDescription = 'asana link not found';

      if (statusState === 'success' && descriptionSearch) {
        const descriptionChecks = await Promise.all(
          foundAsanaTasks.map(taskId => checkTaskDescription(client, taskId, descriptionSearch))
        );
        if (!descriptionChecks.some(result => result === true)) {
          statusState = 'error';
          statusDescription = `Required text "${descriptionSearch}" not found in task description`;
        }
      }

      core.info(`setting ${statusState} for ${github.context.payload.pull_request.head.sha}`);
      octokit.repos.createStatus({
        ...github.context.repo,
        'context': 'asana-link-presence',
        'state': statusState,
        'description': statusDescription,
        'sha': github.context.payload.pull_request.head.sha,
      });
      break;
    }
    case 'add-comment': {
      const commentId = core.getInput('comment-id'),
        htmlText = core.getInput('text', {required: true}),
        isPinned = core.getInput('is-pinned') === 'true';
      const comments = [];
      for(const taskId of foundAsanaTasks) {
        if(commentId){
          const comment = await findComment(client, taskId, commentId);
          if(comment){
            console.info('found existing comment', comment.gid);
            continue;
          }
        }
        const comment = await addComment(client, taskId, commentId, htmlText, isPinned);
        comments.push(comment);
      };
      return comments;
    }
    case 'remove-comment': {
      const commentId = core.getInput('comment-id', {required: true});
      const removedCommentIds = [];
      for(const taskId of foundAsanaTasks) {
        const comment = await findComment(client, taskId, commentId);
        if(comment){
          console.info("removing comment", comment.gid);
          try {
            await client.stories.delete(comment.gid);
          } catch (error) {
            console.error('rejecting promise', error);
          }
          removedCommentIds.push(comment.gid);
        }
      }
      return removedCommentIds;
    }
    case 'complete-task': {
      const isComplete = core.getInput('is-complete') === 'true';
      const taskIds = [];
      for(const taskId of foundAsanaTasks) {
        console.info("marking task", taskId, isComplete ? 'complete' : 'incomplete');
        try {
          await client.tasks.update(taskId, {
            completed: isComplete
          });
        } catch (error) {
          console.error('rejecting promise', error);
        }
        taskIds.push(taskId);
      };
      return taskIds;
    }
    case 'move-section': {
      const targetJSON = core.getInput('targets', {required: true});
      const targets = JSON.parse(targetJSON);
      const movedTasks = [];
      for(const taskId of foundAsanaTasks) {
        await moveSection(client, taskId, targets);
        movedTasks.push(taskId);
      }
      return movedTasks;
    }
    default:
      core.setFailed("unexpected action ${ACTION}");
  }
}

module.exports = {
  action,
  default: action,
  buildClient: buildClient
};
